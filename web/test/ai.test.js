import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAssistant, resolveProvider, describeSheet, extractActions, AiError } from '../lib/ai.js';

// Point the key ring at an empty temp dir so tests never read the developer's real .env
const isolated = () => ({ GRIDS_ENV_FILE: join(mkdtempSync(join(tmpdir(), 'grids-')), '.env') });
const env = { ...isolated(), AI_API_KEY: 'sk-test', AI_BASE_URL: 'https://example.test/v1', AI_MODEL: 'm' };

function fakeFetch(responseBody, status = 200, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return new Response(JSON.stringify(responseBody), { status });
  };
}

test('sends tools + sheet context and returns parsed actions', async () => {
  const cap = {};
  const out = await runAssistant(
    { messages: [{ role: 'user', content: 'add a total' }], sheet: { title: 'T', cells: { A1: { input: '5', value: '5' } } } },
    env,
    fakeFetch({ choices: [{ message: { content: 'Done.', tool_calls: [
      { function: { name: 'set_cells', arguments: '{"cells":[{"ref":"A2","input":"=SUM(A1)"}]}' } },
      { function: { name: 'set_cells', arguments: '{broken' } },
      { function: { name: 'rm_rf', arguments: '{}' } },
    ] } }] }, 200, cap),
  );
  assert.equal(cap.url, 'https://example.test/v1/chat/completions');
  assert.equal(cap.init.headers.authorization, 'Bearer sk-test');
  assert.ok(cap.body.tools.length >= 5);
  assert.match(cap.body.messages[1].content, /A1: "5"/);
  assert.equal(out.reply, 'Done.');
  assert.deepEqual(out.actions, [{ name: 'set_cells', args: { cells: [{ ref: 'A2', input: '=SUM(A1)' }] } }]);
});

test('provider errors become 502 without leaking the key', async () => {
  await assert.rejects(
    runAssistant({ messages: [{ role: 'user', content: 'x' }] }, env, fakeFetch({ error: { message: 'bad model' } }, 400)),
    (e) => e instanceof AiError && e.status === 502 && /bad model/.test(e.message) && !e.message.includes('sk-test'),
  );
});

test('no key configured -> 503', async () => {
  await assert.rejects(runAssistant({ messages: [{ role: 'user', content: 'x' }] }, isolated(), fakeFetch({})), (e) => e.status === 503);
});

test('custom provider is refused unless allowed (SSRF guard)', () => {
  assert.throws(() => resolveProvider({ baseUrl: 'http://169.254.169.254/' }, env), (e) => e.status === 403);
  const allowed = { ...env, ALLOW_CUSTOM_PROVIDER: '1' };
  assert.throws(() => resolveProvider({ baseUrl: 'http://10.0.0.5/v1' }, allowed), (e) => e.status === 400);
  assert.equal(resolveProvider({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' }, allowed).apiKey, '');
  // Server key is never forwarded to a browser-chosen URL
  assert.equal(resolveProvider({ baseUrl: 'https://other.test/v1' }, allowed).apiKey, '');
  assert.equal(resolveProvider({ model: 'other' }, allowed).apiKey, 'sk-test');
});

test('sheet description is capped', () => {
  const cells = {};
  for (let i = 1; i <= 5000; i++) cells[`A${i}`] = { input: String(i), value: String(i) };
  const d = describeSheet({ cells });
  assert.match(d, /truncated/);
  assert.ok(d.length < 80_000);
});

test('last message must be the user', async () => {
  await assert.rejects(runAssistant({ messages: [{ role: 'assistant', content: 'x' }] }, env, fakeFetch({})), (e) => e.status === 400);
  assert.deepEqual(extractActions({}), []);
});
