// AI bridge: one OpenAI-compatible chat-completions call with the shared sheet tools.
//
// "Custom AI" = any provider that speaks /v1/chat/completions with tool calling:
// Groq, OpenRouter, OpenAI, Gemini (OpenAI endpoint), Ollama, LM Studio, vLLM...
// The server holds the keys (a key ring in the local .env, see lib/keyring.js);
// the browser only ever sees key names and usage counts.
//
// Stateless and single-shot: the tools only *write* to the sheet, so the model
// never needs tool results back. The browser applies the returned actions
// (after the user approves them) — the server never touches sheet state.

import { readFileSync } from 'node:fs';
import { KeyRing, DEFAULT_BASE_URL, DEFAULT_MODEL } from './keyring.js';
import { runSubscription, parseTextReply } from './subscriptions.js';

const SHARED = new URL('../../shared/ai/', import.meta.url);
export const TOOLS = JSON.parse(readFileSync(new URL('tools.json', SHARED), 'utf8'));
const SYSTEM_PROMPT = readFileSync(new URL('system-prompt.md', SHARED), 'utf8');
const TEXT_PROTOCOL = readFileSync(new URL('text-protocol.md', SHARED), 'utf8');

/** Single prompt for CLIs without function calling (subscriptions). */
export function textPrompt(messages) {
  const [system, sheet, ...history] = messages;
  return [
    system.content,
    TEXT_PROTOCOL + JSON.stringify(TOOLS),
    sheet.content,
    '## Conversation',
    ...history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
    '',
    'Reply now with the single JSON object.',
  ].join('\n\n');
}

const MAX_CONTEXT_CELLS = 2000;
const MAX_CONTEXT_CHARS = 60_000;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 8000;
const TIMEOUT_MS = 90_000;

export class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Server default provider (no key). Defaults target Groq's free tier. */
export function serverProvider(env = process.env) {
  return {
    baseUrl: (env.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: env.AI_MODEL || DEFAULT_MODEL,
    apiKey: env.AI_API_KEY || '',
  };
}

export function allowCustomProvider(env = process.env) {
  return env.ALLOW_CUSTOM_PROVIDER === '1';
}

const isLocal = (url) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

/**
 * Pick the provider for a request. A browser-supplied provider is only honoured when
 * ALLOW_CUSTOM_PROVIDER=1: otherwise a hosted server would fetch any URL a visitor
 * names (SSRF) and could be used as an open proxy.
 */
export function resolveProvider(requested, env = process.env) {
  const base = serverProvider(env);
  if (!requested || (!requested.baseUrl && !requested.model && !requested.apiKey)) return null; // use the key ring
  if (!allowCustomProvider(env)) throw new AiError(403, 'This server does not allow a custom AI provider (set ALLOW_CUSTOM_PROVIDER=1).');
  const p = {
    baseUrl: String(requested.baseUrl || base.baseUrl).replace(/\/+$/, ''),
    model: String(requested.model || base.model),
    apiKey: requested.apiKey ? String(requested.apiKey) : requested.baseUrl ? '' : base.apiKey,
  };
  let url;
  try {
    url = new URL(p.baseUrl);
  } catch {
    throw new AiError(400, 'Provider URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal(url))) {
    throw new AiError(400, 'Provider URL must be https (or http on localhost).');
  }
  return p;
}

/** Compact, size-capped text view of the sheet for the model. */
export function describeSheet(sheet = {}) {
  const lines = [];
  let chars = 0;
  let truncated = false;
  const cells = Object.entries(sheet.cells ?? {});
  for (const [ref, c] of cells) {
    if (lines.length >= MAX_CONTEXT_CELLS || chars > MAX_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
    const input = String(c?.input ?? '').slice(0, 500);
    const value = c?.value === undefined || String(c.value) === input ? '' : `  → ${String(c.value).slice(0, 200)}`;
    const line = `${ref}: ${JSON.stringify(input)}${value}`;
    lines.push(line);
    chars += line.length;
  }
  const head = [
    `Workbook title: ${JSON.stringify(String(sheet.title ?? 'Untitled').slice(0, 200))}`,
    `Selected: ${String(sheet.selection ?? 'A1').slice(0, 20)}`,
    `Non-empty cells (${cells.length})${truncated ? ` — truncated to the first ${lines.length}` : ''}. Format: REF: "input" → value`,
  ];
  return [...head, ...(lines.length ? lines : ['(sheet is empty)'])].join('\n');
}

function cleanHistory(messages) {
  if (!Array.isArray(messages)) throw new AiError(400, 'messages must be an array');
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

/** Turn the model's tool calls into plain {name, args} actions; drop malformed ones. */
export function extractActions(message) {
  const known = new Set(TOOLS.map((t) => t.function.name));
  const actions = [];
  for (const call of message?.tool_calls ?? []) {
    const name = call?.function?.name;
    if (!known.has(name)) continue;
    try {
      const args = JSON.parse(call.function.arguments || '{}');
      if (args && typeof args === 'object') actions.push({ name, args });
    } catch {
      // Models occasionally emit broken JSON; skip that call rather than fail the reply
    }
  }
  return actions;
}

/** One chat-completions call. Never throws for HTTP errors: the caller decides whether to fail over. */
async function callProvider(provider, messages, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'grids/0.1',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: provider.model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, status: 0, detail: `Could not reach the AI provider (${e.name === 'TimeoutError' ? 'timed out' : e.message}).` };
  }
  const text = await res.text();
  if (!res.ok) {
    // Provider error bodies are safe to surface (they never contain our key), but keep them short
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.error?.message?.slice(0, 300) ?? detail;
    } catch {}
    return { ok: false, status: res.status, retryAfterS: Number(res.headers?.get?.('retry-after')) || 0, detail: `AI provider returned ${res.status}: ${detail}` };
  }
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: 502, detail: 'AI provider returned invalid JSON.' };
  }
}

/** Statuses where another key may work: rate limit, bad/expired key, out of credit. */
const FAILOVER = new Set([401, 402, 403, 429]);

/**
 * @param body {messages, sheet, provider?, key?}   key = "auto" | key name
 * @returns {Promise<{reply, actions, model, key}>}
 */
export async function runAssistant(body, env = process.env, fetchImpl = fetch, ring = new KeyRing(env), runSub = runSubscription) {
  const custom = resolveProvider(body?.provider, env);
  const history = cleanHistory(body?.messages);
  if (!history.length || history.at(-1).role !== 'user') throw new AiError(400, 'The last message must be from the user.');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'system', content: `Current sheet:
${describeSheet(body.sheet)}` },
    ...history,
  ];

  let tries;
  if (custom) tries = [{ name: null, ...custom }];
  else {
    try {
      tries = ring.candidates(typeof body?.key === 'string' && body.key ? body.key : undefined);
    } catch (e) {
      throw new AiError(e.status ?? 400, e.message);
    }
    if (!tries.length) {
      throw new AiError(503, ring.keys().length
        ? 'Every AI key is used up for today or cooling down after a rate limit. Add a key, raise a limit, or wait.'
        : `No AI key or subscription is configured. Add one in AI settings or in ${ring.path} (see shared/KEYS.md).`);
    }
  }

  let last;
  for (const p of tries) {
    if (p.type === 'sub') {
      const r = await runSub(p, textPrompt(messages));
      ring.record(p.name, { ok: r.ok, status: r.status, tokens: r.tokens ?? 0, error: r.detail });
      if (r.ok) {
        const { reply, calls } = parseTextReply(r.text);
        const actions = extractActions({
          tool_calls: calls.map((c) => ({ function: { name: c?.name, arguments: JSON.stringify(c?.args ?? {}) } })),
        });
        return { reply: reply || (actions.length ? `Prepared ${actions.length} change${actions.length === 1 ? '' : 's'}.` : '(no reply)'), actions, model: p.model || p.kind, key: p.name };
      }
      last = r;
      if (!FAILOVER.has(r.status)) break;
      continue;
    }
    if (!p.apiKey && !isLocal(new URL(p.baseUrl))) {
      last = { detail: 'No AI key is configured for this provider.' };
      continue;
    }
    const r = await callProvider(p, messages, fetchImpl);
    if (p.name) ring.record(p.name, { ok: r.ok, status: r.status, tokens: r.data?.usage?.total_tokens ?? 0, retryAfterS: r.retryAfterS, error: r.detail });
    if (r.ok) {
      const message = r.data?.choices?.[0]?.message ?? {};
      const actions = extractActions(message);
      const reply = typeof message.content === 'string' && message.content.trim()
        ? message.content.trim()
        : actions.length ? `Prepared ${actions.length} change${actions.length === 1 ? '' : 's'}.` : '(no reply)';
      return { reply, actions, model: p.model, key: p.name };
    }
    last = r;
    if (!FAILOVER.has(r.status)) break; // a bad request won't succeed on another key
  }
  const switched = tries.length > 1 ? ` (tried ${tries.map((t) => t.name).join(', ')})` : '';
  throw new AiError(502, `${last?.detail ?? 'AI request failed.'}${switched}`);
}
