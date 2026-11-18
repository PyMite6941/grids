// Key ring: several AI connections in one local .env (API keys and subscriptions),
// with per-connection daily usage so the user (or "auto") can switch as they get used
// up. Same rules as the desktop KeyRing.java — see shared/KEYS.md.
//
//   AI_KEY_<NAME>=sk-...            an API key (NAME: A-Z 0-9 _)
//   AI_SUB_<NAME>=claude|codex|gemini   a subscription, used through that vendor's CLI
//   AI_SUB_<NAME>_BIN=...           optional: path to the CLI (hand-edit only)
//   AI_KEY_<NAME>_LIMIT=1000        optional: requests/day before auto stops picking it
//   AI_KEY_<NAME>_BASE_URL=...      optional: this key's provider (default AI_BASE_URL)
//   AI_KEY_<NAME>_MODEL=...         optional: this key's model (default AI_MODEL)
//   (_LIMIT and _MODEL work for AI_SUB_ too)
//   AI_KEY_SELECT=auto|<NAME>       default choice
//   AI_API_KEY=...                  legacy single key, shows up as DEFAULT
//
// Usage lives in .grids-usage.json beside the .env. It holds names and counts only,
// never key material. The .env is re-read on every call, so edits apply without a restart.

import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, detect, validModel } from './subscriptions.js';

export const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const SUFFIXES = ['_LIMIT', '_BASE_URL', '_MODEL', '_BIN'];
const NAME_RE = /^[A-Z0-9_]{1,32}$/;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 60 * 60_000;

export const envFilePath = (env = process.env) =>
  env.GRIDS_ENV_FILE || fileURLToPath(new URL('../../.env', import.meta.url));

/** Minimal .env parser: KEY=VALUE, `export `, quotes, # comments. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export function validName(name) {
  return NAME_RE.test(name) && !SUFFIXES.some((s) => name.endsWith(s)) && name !== 'SELECT';
}

const today = () => new Date().toISOString().slice(0, 10);

export class KeyRing {
  /** allowSubs: whether subscription CLIs may be used (local servers only). */
  constructor(env = process.env, now = () => Date.now(), { allowSubs = true } = {}) {
    this.env = env;
    this.allowSubs = allowSubs;
    this.now = now;
    this.path = envFilePath(env);
    this.usagePath = join(dirname(this.path), '.grids-usage.json');
    this.usage = this.#loadUsage();
  }

  /** process.env overlaid with the .env file (file wins: it's what the user just edited). */
  vars() {
    let file = {};
    try {
      file = parseEnv(readFileSync(this.path, 'utf8'));
    } catch {}
    return { ...this.env, ...file };
  }

  keys() {
    const v = this.vars();
    const baseUrl = (v.AI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = v.AI_MODEL || DEFAULT_MODEL;
    const keys = [];
    for (const [k, val] of Object.entries(v)) {
      const type = k.startsWith('AI_KEY_') ? 'key' : k.startsWith('AI_SUB_') ? 'sub' : null;
      const name = type ? k.slice(7) : null;
      if (!name || !validName(name) || !val || keys.some((x) => x.name === name)) continue;
      const lim = Number(v[`${k}_LIMIT`]);
      const limit = Number.isFinite(lim) && lim > 0 ? Math.floor(lim) : null;
      if (type === 'key') {
        keys.push({ name, type, apiKey: val, baseUrl: (v[`${k}_BASE_URL`] || baseUrl).replace(/\/+$/, ''), model: v[`${k}_MODEL`] || model, limit });
      } else if (KINDS[val.toLowerCase()]) {
        const m = v[`${k}_MODEL`] || '';
        keys.push({ name, type, kind: val.toLowerCase(), model: validModel(m) ? m : '', bin: v[`${k}_BIN`] || '', limit });
      }
    }
    if (v.AI_API_KEY && !keys.some((k) => k.name === 'DEFAULT')) {
      keys.unshift({ name: 'DEFAULT', type: 'key', apiKey: v.AI_API_KEY, baseUrl, model, limit: null });
    }
    // A keyless local provider (Ollama, LM Studio) still counts as usable
    if (!keys.length) {
      try {
        if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) keys.push({ name: 'LOCAL', type: 'key', apiKey: '', baseUrl, model, limit: null });
      } catch {}
    }
    return keys;
  }

  defaultSelection() {
    return this.vars().AI_KEY_SELECT || 'auto';
  }

  #loadUsage() {
    try {
      const u = JSON.parse(readFileSync(this.usagePath, 'utf8'));
      if (u && typeof u === 'object' && u.keys && typeof u.keys === 'object') return u;
    } catch {}
    return { day: today(), keys: {} };
  }

  #rollDay() {
    if (this.usage.day !== today()) {
      // Counts reset daily; cooldowns survive (they're absolute timestamps)
      const keys = {};
      for (const [n, u] of Object.entries(this.usage.keys)) keys[n] = { requests: 0, tokens: 0, rateLimited: 0, total: u.total ?? 0, cooldownUntil: u.cooldownUntil ?? 0, lastError: u.lastError ?? '' };
      this.usage = { day: today(), keys };
    }
  }

  stats(name) {
    this.#rollDay();
    return this.usage.keys[name] ?? { requests: 0, tokens: 0, rateLimited: 0, total: 0, cooldownUntil: 0, lastError: '' };
  }

  #save() {
    try {
      const tmp = `${this.usagePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.usage, null, 2));
      renameSync(tmp, this.usagePath);
    } catch {
      // Read-only filesystem (serverless): usage stays in memory for this process
    }
  }

  available(key) {
    if (key.type === 'sub' && !this.allowSubs) return false;
    const s = this.stats(key.name);
    return s.cooldownUntil <= this.now() && (key.limit == null || s.requests < key.limit);
  }

  /** Fraction of the day's budget used; unlimited keys rank by raw count. */
  #score(key) {
    const s = this.stats(key.name);
    return key.limit ? s.requests / key.limit : s.requests / 10_000;
  }

  /**
   * Keys to try, in order. A named selection is just that key (no silent switching —
   * the user chose it). "auto" = every available key, most headroom first.
   */
  candidates(selection) {
    const keys = this.keys();
    const sel = selection || this.defaultSelection();
    if (sel !== 'auto') {
      const k = keys.find((k) => k.name === sel);
      if (!k) throw Object.assign(new Error(`No AI key named ${sel} in ${this.path}.`), { status: 400 });
      if (k.type === 'sub' && !this.allowSubs) throw Object.assign(new Error('Subscriptions only work on a Grids server running on your own computer.'), { status: 403 });
      // The daily limit is the user's own budget, so it holds even for a named pick.
      // (A cooldown doesn't: choosing a cooling key by name is a deliberate retry.)
      if (k.limit && this.stats(k.name).requests >= k.limit) {
        throw Object.assign(new Error(`${k.name} has used its ${k.limit} requests for today. Pick Auto or another connection, or raise its limit.`), { status: 429 });
      }
      return [k];
    }
    return keys
      .filter((k) => this.available(k))
      .map((k, i) => ({ k, i, s: this.#score(k) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.k);
  }

  record(name, { ok, status = 0, tokens = 0, retryAfterS = 0, error = '' }) {
    this.#rollDay();
    const s = (this.usage.keys[name] = { ...this.stats(name) });
    s.requests += 1;
    s.total = (s.total ?? 0) + 1;
    s.tokens += Number.isFinite(tokens) ? tokens : 0;
    s.lastUsed = new Date(this.now()).toISOString();
    if (ok) s.lastError = '';
    else {
      s.lastError = String(error).slice(0, 200);
      if (status === 429) {
        s.rateLimited += 1;
        s.cooldownUntil = this.now() + (retryAfterS > 0 ? Math.min(retryAfterS, 3600) * 1000 : RATE_LIMIT_COOLDOWN_MS);
      } else if (status === 401 || status === 402 || status === 403) {
        s.cooldownUntil = this.now() + AUTH_COOLDOWN_MS; // bad key / out of credit
      }
    }
    this.#save();
  }

  /** Public view for the UI: never includes the key itself. */
  summary() {
    return this.keys().map((k) => {
      const s = this.stats(k.name);
      let host = '';
      if (k.type === 'key') {
        try {
          host = new URL(k.baseUrl).host;
        } catch {}
      }
      const sub = k.type === 'sub' ? KINDS[k.kind] : null;
      return {
        name: k.name,
        type: k.type,
        kind: k.kind ?? null,
        label: sub ? sub.label : host,
        installed: sub ? Boolean(k.bin || detect(sub.bin)) : null,
        model: k.model || (sub ? '(CLI default)' : ''),
        host,
        limit: k.limit,
        requests: s.requests,
        tokens: s.tokens,
        rateLimited: s.rateLimited,
        coolingFor: Math.max(0, Math.ceil((s.cooldownUntil - this.now()) / 1000)),
        lastError: s.lastError || '',
        available: this.available(k),
        hint: sub ? 'subscription' : k.apiKey ? `…${k.apiKey.slice(-4)}` : '(none)',
      };
    });
  }

  // ---------- editing the .env (local use only; the server gates this) ----------

  #rewrite(mutate) {
    let lines = [];
    try {
      lines = readFileSync(this.path, 'utf8').split(/\r?\n/);
    } catch {}
    if (lines.at(-1) === '') lines.pop();
    lines = mutate(lines);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {}
  }

  static #clean(v, max) {
    const s = String(v ?? '').trim();
    if (/[\r\n"]/.test(s)) throw Object.assign(new Error('Values cannot contain newlines or quotes.'), { status: 400 });
    return s.slice(0, max);
  }

  addKey({ name, apiKey, limit, baseUrl, model }) {
    name = String(name ?? '').trim().toUpperCase();
    if (!validName(name) || name === 'DEFAULT' || name === 'LOCAL') {
      throw Object.assign(new Error('Name must be 1–32 of A–Z, 0–9, _ (and not end in _LIMIT/_MODEL/_BASE_URL).'), { status: 400 });
    }
    const key = KeyRing.#clean(apiKey, 500);
    if (!key) throw Object.assign(new Error('API key is empty.'), { status: 400 });
    const url = KeyRing.#clean(baseUrl, 300);
    if (url) {
      let u;
      try {
        u = new URL(url);
      } catch {
        throw Object.assign(new Error('Base URL is not a valid URL.'), { status: 400 });
      }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
        throw Object.assign(new Error('Base URL must be https (or http on localhost).'), { status: 400 });
      }
    }
    const lim = limit === '' || limit == null ? null : Math.floor(Number(limit));
    if (lim != null && !(lim > 0)) throw Object.assign(new Error('Limit must be a positive whole number.'), { status: 400 });
    const mdl = KeyRing.#clean(model, 200);
    this.#rewrite((lines) => {
      const kept = KeyRing.#without(lines, name);
      if (!existsSync(this.path) || !kept.some((l) => l.trim())) kept.unshift('# Grids AI keys — local only, never commit this file. See shared/KEYS.md.');
      kept.push(`AI_KEY_${name}="${key}"`);
      if (lim != null) kept.push(`AI_KEY_${name}_LIMIT=${lim}`);
      if (url) kept.push(`AI_KEY_${name}_BASE_URL=${url}`);
      if (mdl) kept.push(`AI_KEY_${name}_MODEL=${mdl}`);
      return kept;
    });
    return name;
  }

  /** Subscriptions: only the CLI type, a name, limit and model. The CLI path stays hand-edited. */
  addSubscription({ name, kind, limit, model }) {
    name = String(name ?? '').trim().toUpperCase();
    if (!validName(name) || name === 'DEFAULT' || name === 'LOCAL') throw Object.assign(new Error('Name must be 1–32 of A–Z, 0–9, _.'), { status: 400 });
    if (!KINDS[kind]) throw Object.assign(new Error(`Type must be one of ${Object.keys(KINDS).join(', ')}.`), { status: 400 });
    const mdl = String(model ?? '').trim();
    if (!validModel(mdl)) throw Object.assign(new Error('Model may only contain letters, digits and . _ : / -'), { status: 400 });
    const lim = limit === '' || limit == null ? null : Math.floor(Number(limit));
    if (lim != null && !(lim > 0)) throw Object.assign(new Error('Limit must be a positive whole number.'), { status: 400 });
    this.#rewrite((lines) => {
      const kept = KeyRing.#without(lines, name);
      if (!kept.some((l) => l.trim())) kept.unshift('# Grids AI keys — local only, never commit this file. See shared/KEYS.md.');
      kept.push(`AI_SUB_${name}=${kind}`);
      if (lim != null) kept.push(`AI_SUB_${name}_LIMIT=${lim}`);
      if (mdl) kept.push(`AI_SUB_${name}_MODEL=${mdl}`);
      return kept;
    });
    return name;
  }

  removeKey(name) {
    if (name === 'DEFAULT') {
      this.#rewrite((lines) => lines.filter((l) => !/^\s*(?:export\s+)?AI_API_KEY\s*=/.test(l)));
    } else {
      if (!validName(name)) throw Object.assign(new Error('Bad key name.'), { status: 400 });
      this.#rewrite((lines) => KeyRing.#without(lines, name));
    }
    delete this.usage.keys[name];
    this.#save();
  }

  setSelection(sel) {
    if (sel !== 'auto' && !validName(sel)) throw Object.assign(new Error('Bad selection.'), { status: 400 });
    this.#rewrite((lines) => [...lines.filter((l) => !/^\s*(?:export\s+)?AI_KEY_SELECT\s*=/.test(l)), `AI_KEY_SELECT=${sel}`]);
  }

  static #without(lines, name) {
    const re = new RegExp(`^\\s*(?:export\\s+)?AI_(?:KEY|SUB)_${name}(?:_LIMIT|_BASE_URL|_MODEL|_BIN)?\\s*=`);
    return lines.filter((l) => !re.test(l));
  }
}
