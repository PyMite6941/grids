import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyRing, parseEnv } from '../lib/keyring.js';
import { runAssistant, textPrompt } from '../lib/ai.js';
import { parseTextReply, classifyFailure, KINDS } from '../lib/subscriptions.js';

function setup(envText = '') {
  const dir = mkdtempSync(join(tmpdir(), 'grids-keys-'));
  const file = join(dir, '.env');
  if (envText) writeFileSync(file, envText);
  return { dir, file, env: { GRIDS_ENV_FILE: file } };
}

const ok = (tokens = 10) => new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { total_tokens: tokens } }), { status: 200 });
const err = (status, headers = {}) => new Response(JSON.stringify({ error: { message: `nope ${status}` } }), { status, headers });
const ask = { messages: [{ role: 'user', content: 'x' }] };
const noFetch = async () => {
  throw new Error('fetch should not be called');
};

test('parses .env with quotes, comments and export', () => {
  assert.deepEqual(parseEnv('# c\nexport A=1\nB="x # y"\nC=z   # note\nbad line\n'), { A: '1', B: 'x # y', C: 'z' });
});

test('lists keys, subscriptions and the legacy key', () => {
  const { env } = setup(
    'AI_BASE_URL=https://a.test/v1\nAI_MODEL=m1\nAI_API_KEY=sk-legacy\nAI_KEY_FAST=sk-fast\nAI_KEY_FAST_LIMIT=5\n' +
      'AI_KEY_OR=sk-or\nAI_KEY_OR_BASE_URL=https://b.test/v1/\nAI_KEY_OR_MODEL=m2\nAI_SUB_CLAUDE=claude\nAI_SUB_CLAUDE_LIMIT=40\n' +
      'AI_SUB_WEIRD=notacli\nAI_KEY_SELECT=FAST\n',
  );
  const ring = new KeyRing(env);
  const keys = ring.keys();
  assert.deepEqual(keys.map((k) => [k.name, k.type]), [['DEFAULT', 'key'], ['FAST', 'key'], ['OR', 'key'], ['CLAUDE', 'sub']]);
  assert.equal(keys[1].limit, 5);
  assert.equal(keys[2].baseUrl, 'https://b.test/v1');
  assert.equal(keys[2].model, 'm2');
  assert.equal(keys[3].kind, 'claude');
  assert.equal(keys[3].limit, 40);
  assert.equal(ring.defaultSelection(), 'FAST');
  // Summary never exposes key material
  assert.ok(!JSON.stringify(ring.summary()).includes('sk-'));
});

test('auto picks the connection with the most headroom and skips exhausted ones', () => {
  const { env } = setup('AI_KEY_A=ka\nAI_KEY_A_LIMIT=2\nAI_KEY_B=kb\nAI_KEY_B_LIMIT=100\n');
  const ring = new KeyRing(env);
  assert.equal(ring.candidates('auto')[0].name, 'A'); // tie -> file order
  ring.record('A', { ok: true });
  assert.equal(ring.candidates('auto')[0].name, 'B'); // A is 50% used, B 0%
  ring.record('A', { ok: true });
  assert.deepEqual(ring.candidates('auto').map((k) => k.name), ['B']); // A hit its limit
  // A named choice still respects the user's own daily limit…
  assert.throws(() => ring.candidates('A'), (e) => e.status === 429 && /used its 2 requests/.test(e.message));
  assert.throws(() => ring.candidates('NOPE'), /No AI key named NOPE/);
  // …but a cooldown alone doesn't block it: picking it by name is a deliberate retry
  ring.record('B', { ok: false, status: 429, retryAfterS: 30 });
  assert.equal(ring.available(ring.keys().find((k) => k.name === 'B')), false);
  assert.equal(ring.candidates('B')[0].name, 'B');
});

test('usage persists without key material and resets per day', () => {
  const { env, dir } = setup('AI_KEY_A=sk-secret-a\n');
  new KeyRing(env).record('A', { ok: true, tokens: 42 });
  const saved = readFileSync(join(dir, '.grids-usage.json'), 'utf8');
  assert.ok(!saved.includes('sk-secret'));
  assert.equal(new KeyRing(env).stats('A').tokens, 42);
  const u = JSON.parse(saved);
  u.day = '2000-01-01';
  writeFileSync(join(dir, '.grids-usage.json'), JSON.stringify(u));
  assert.equal(new KeyRing(env).stats('A').requests, 0);
});

test('auto fails over on 429 and puts the key on cooldown', async () => {
  const { env } = setup('AI_BASE_URL=https://p.test/v1\nAI_KEY_A=ka\nAI_KEY_B=kb\n');
  const ring = new KeyRing(env);
  const used = [];
  const fetchImpl = async (url, init) => {
    used.push(init.headers.authorization);
    return used.length === 1 ? err(429, { 'retry-after': '30' }) : ok(7);
  };
  const out = await runAssistant({ ...ask, key: 'auto' }, env, fetchImpl, ring);
  assert.deepEqual(used, ['Bearer ka', 'Bearer kb']);
  assert.equal(out.key, 'B');
  const a = ring.summary().find((k) => k.name === 'A');
  assert.equal(a.rateLimited, 1);
  assert.ok(a.coolingFor > 0 && a.coolingFor <= 30);
  assert.equal(ring.summary().find((k) => k.name === 'B').tokens, 7);
  // Next auto request skips the cooling key
  used.length = 0;
  await runAssistant({ ...ask, key: 'auto' }, env, async (u, init) => (used.push(init.headers.authorization), ok()), ring);
  assert.deepEqual(used, ['Bearer kb']);
});

test('a named key does not silently switch; 400s do not fail over', async () => {
  const { env } = setup('AI_BASE_URL=https://p.test/v1\nAI_KEY_A=ka\nAI_KEY_B=kb\n');
  let calls = 0;
  await assert.rejects(runAssistant({ ...ask, key: 'A' }, env, async () => (calls++, err(429)), new KeyRing(env)), /429/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(runAssistant({ ...ask, key: 'auto' }, env, async () => (calls++, err(400)), new KeyRing(env)), /400/);
  assert.equal(calls, 1);
});

test('everything exhausted -> clear 503', async () => {
  const { env } = setup('AI_KEY_A=ka\nAI_KEY_A_LIMIT=1\n');
  const ring = new KeyRing(env);
  ring.record('A', { ok: true });
  await assert.rejects(runAssistant(ask, env, async () => ok(), ring), (e) => e.status === 503 && /used up/.test(e.message));
});

test('subscription: JSON text reply becomes validated actions', async () => {
  const { env } = setup('AI_SUB_MAX=claude\n');
  const ring = new KeyRing(env);
  let prompt = '';
  const runSub = async (conn, p) => {
    prompt = p;
    assert.equal(conn.kind, 'claude');
    return {
      ok: true,
      tokens: 120,
      text: 'Sure!\n```json\n{"reply":"Added a total.","actions":[{"name":"set_cells","args":{"cells":[{"ref":"A3","input":"=SUM(A1:A2)"}]}},{"name":"rm_rf","args":{}}]}\n```',
    };
  };
  const out = await runAssistant({ ...ask, sheet: { cells: { A1: { input: '1' } } } }, env, noFetch, ring, runSub);
  assert.equal(out.reply, 'Added a total.');
  assert.deepEqual(out.actions, [{ name: 'set_cells', args: { cells: [{ ref: 'A3', input: '=SUM(A1:A2)' }] } }]);
  assert.equal(out.key, 'MAX');
  assert.match(prompt, /single JSON object/);
  assert.match(prompt, /set_cells/);
  assert.match(prompt, /A1: "1"/);
  assert.equal(ring.stats('MAX').tokens, 120);
});

test('subscription usage limit fails over to an API key', async () => {
  const { env } = setup('AI_BASE_URL=https://p.test/v1\nAI_SUB_MAX=claude\nAI_KEY_BACKUP=kb\n');
  const ring = new KeyRing(env);
  const out = await runAssistant(ask, env, async () => ok(), ring, async () => ({ ok: false, status: classifyFailure('Claude AI usage limit reached'), detail: 'limit' }));
  assert.equal(out.key, 'BACKUP');
  assert.ok(ring.summary().find((k) => k.name === 'MAX').coolingFor > 0);
});

test('subscriptions are off on a non-local server', async () => {
  const { env } = setup('AI_SUB_MAX=claude\n');
  const ring = new KeyRing(env, Date.now, { allowSubs: false });
  await assert.rejects(runAssistant(ask, env, noFetch, ring, async () => ({ ok: true, text: '{}' })), (e) => e.status === 503);
  assert.throws(() => ring.candidates('MAX'), /own computer/);
});

test('text replies: plain prose is a reply with no actions', () => {
  assert.deepEqual(parseTextReply('Just an answer.'), { reply: 'Just an answer.', calls: [] });
  assert.deepEqual(parseTextReply('{"reply":"r","actions":[]}'), { reply: 'r', calls: [] });
  assert.equal(classifyFailure('Error: not logged in. Please run /login'), 401);
  assert.equal(classifyFailure('RESOURCE_EXHAUSTED: quota'), 429);
  assert.equal(classifyFailure('When using Gemini API, you must specify the GEMINI_API_KEY environment variable.'), 401);
  assert.equal(classifyFailure('segfault'), 500);
  assert.ok(textPrompt([{ content: 'S' }, { content: 'Current sheet:' }, { role: 'user', content: 'hi' }]).includes('User: hi'));
});

test('claude CLI output parsing', () => {
  assert.deepEqual(KINDS.claude.parse(JSON.stringify({ type: 'result', result: '{"reply":"x"}', usage: { input_tokens: 5, output_tokens: 3 } })), { text: '{"reply":"x"}', tokens: 8 });
  assert.throws(() => KINDS.claude.parse(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached' })), /usage limit/);
  assert.deepEqual(KINDS.gemini.parse(JSON.stringify({ response: 'r', stats: { models: { a: { tokens: { total: 9 } } } } })), { text: 'r', tokens: 9 });
});

test('add / remove / select edit the .env and keep unrelated lines', () => {
  const { env, file } = setup('PORT=5173\n# keep me\nAI_KEY_OLD=ko\nAI_KEY_OLD_LIMIT=3\n');
  const ring = new KeyRing(env);
  ring.addKey({ name: 'groq2', apiKey: 'gsk_abc', limit: '900', model: 'openai/gpt-oss-20b' });
  ring.addSubscription({ name: 'chatgpt', kind: 'codex', limit: '50' });
  ring.removeKey('OLD');
  ring.setSelection('GROQ2');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^PORT=5173$/m);
  assert.match(text, /^# keep me$/m);
  assert.doesNotMatch(text, /AI_KEY_OLD/);
  assert.match(text, /^AI_KEY_GROQ2="gsk_abc"$/m);
  assert.match(text, /^AI_KEY_GROQ2_LIMIT=900$/m);
  assert.match(text, /^AI_SUB_CHATGPT=codex$/m);
  assert.deepEqual(ring.keys().map((k) => [k.name, k.model, k.limit]), [['GROQ2', 'openai/gpt-oss-20b', 900], ['CHATGPT', '', 50]]);
  assert.equal(ring.defaultSelection(), 'GROQ2');
  ring.removeKey('CHATGPT');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /CHATGPT/);
});

test('add rejects injection into the .env and unsafe values', () => {
  const { env, file } = setup();
  const ring = new KeyRing(env);
  assert.throws(() => ring.addKey({ name: 'X', apiKey: 'a\nAI_KEY_EVIL=1' }), /newlines/);
  assert.throws(() => ring.addKey({ name: 'X', apiKey: 'a"b' }), /quotes/);
  assert.throws(() => ring.addKey({ name: 'bad-name', apiKey: 'k' }), /Name/);
  assert.throws(() => ring.addKey({ name: 'X_LIMIT', apiKey: 'k' }), /Name/);
  assert.throws(() => ring.addKey({ name: 'X', apiKey: 'k', baseUrl: 'http://10.0.0.1/v1' }), /https/);
  assert.throws(() => ring.addKey({ name: 'X', apiKey: 'k', limit: '-4' }), /Limit/);
  assert.throws(() => ring.addSubscription({ name: 'X', kind: 'bash' }), /Type/);
  assert.throws(() => ring.addSubscription({ name: 'X', kind: 'claude', model: 'opus; rm -rf /' }), /Model/);
  assert.ok(!existsSync(file));
});
