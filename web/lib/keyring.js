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

import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KINDS, detect, validModel } from './subscriptions.js';

export const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const SUFFIXES = ['_LIMIT', '_BASE_URL', '_MODEL', '_BIN'];
const NAME_RE = /^[A-Z0-9_]{1,32}$/;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 60 * 60_000;

export const repoEnvPath = () => fileURLToPath(new URL('../../.env', import.meta.url));
export const homeEnvPath = () => join(homedir(), '.grids', '.env');

/**
 * GRIDS_ENV_FILE, else the repo's .env if it exists, else ~/.grids/.env if it exists,
 * else the repo's .env (created on first save). Same order as KeyRing.java.
 */
export function envFilePath(env = process.env) {
  if (env.GRIDS_ENV_FILE) return env.GRIDS_ENV_FILE;
  const repo = repoEnvPath();
  if (existsSync(repo)) return repo;
  const home = homeEnvPath();
  return existsSync(home) ? home : repo;
}

const SYNC_DIRS = ['onedrive', 'dropbox', 'google drive', 'googledrive', 'icloud drive', 'iclouddrive', 'mobile documents', 'box sync', 'pcloud'];

/** True when the path is inside a cloud-synced folder, where keys would be uploaded. */
export function inSyncedFolder(path, env = process.env) {
  const p = String(path).toLowerCase();
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean).map((r) => r.toLowerCase());
  if (roots.some((r) => p.startsWith(r.endsWith(sep) ? r : r + sep))) return true;
  return p.split(/[\\/]/).some((seg) => SYNC_DIRS.some((d) => seg === d || seg.startsWith(d + ' -') || seg.startsWith(d + '-')));
}

// Key-shaped strings providers sometimes echo back in error messages.
const KEY_PATTERNS = [/\b(?:sk|gsk|xai|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, /\bAIza[0-9A-Za-z_-]{20,}/g, /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi];

/** Remove the given secrets and anything key-shaped from text that will be stored or shown. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const k of secrets) if (k && k.length >= 6) s = s.split(k).join('[redacted]');
  for (const re of KEY_PATTERNS) s = s.replace(re, '[redacted]');
  return s;
}

/**
 * Make a file readable by its owner only. POSIX: mode 600. Windows: chmod is a no-op,
 * so drop inherited ACEs and grant only the current user (icacls, no shell).
 */
export function secureFile(path) {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
      if (!user) return false;
      execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true });
    } else {
      chmodSync(path, 0o600);
    }
    return true;
  } catch {
    return false;
  }
}

const err = (status, message) => Object.assign(new Error(message), { status });
const HEADER = '# Grids AI keys — local only, never commit or share this file. See shared/KEYS.md.';

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
      const secrets = this.keys().map((k) => k.apiKey);
      s.lastError = redact(error, secrets).slice(0, 200);
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
    const v = this.vars();
    const prefix = (k) => (k.type === 'sub' ? `AI_SUB_${k.name}` : `AI_KEY_${k.name}`);
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
        // What the .env itself says (no defaults filled in), so the Edit form can prefill
        config: {
          limit: v[`${prefix(k)}_LIMIT`] ?? '',
          baseUrl: k.type === 'key' ? v[`${prefix(k)}_BASE_URL`] ?? '' : '',
          model: v[`${prefix(k)}_MODEL`] ?? '',
        },
        editable: k.name !== 'LOCAL' && k.name !== 'DEFAULT',
      };
    });
  }

  /** Where the key file is and whether it is somewhere risky. Never includes contents. */
  fileInfo() {
    const home = homeEnvPath();
    return {
      path: this.path,
      exists: existsSync(this.path),
      location: this.env.GRIDS_ENV_FILE ? 'custom' : this.path === home ? 'home' : 'repo',
      synced: inSyncedFolder(this.path, this.env),
      homePath: home,
    };
  }

  /** Re-apply owner-only permissions to an existing key file (called at startup). */
  secure() {
    return existsSync(this.path) ? secureFile(this.path) : false;
  }

  // ---------- editing the .env (local use only; the server gates this) ----------

  #rewrite(mutate) {
    let lines = [];
    try {
      lines = readFileSync(this.path, 'utf8').split(/\r?\n/);
    } catch {}
    if (lines.at(-1) === '') lines.pop();
    lines = mutate(lines);
    if (!lines.some((l) => l.trim())) lines.unshift(HEADER);
    mkdirSync(dirname(this.path), { recursive: true });
    // A stale temp file would keep its old permissions (mode only applies on create)
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      unlinkSync(tmp);
    } catch {}
    writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
    secureFile(this.path);
  }

  static #clean(v, max) {
    const s = String(v ?? '').trim();
    if (/[\r\n"]/.test(s)) throw err(400, 'Values cannot contain newlines or quotes.');
    return s.slice(0, max);
  }

  static #name(name) {
    const n = String(name ?? '').trim().toUpperCase();
    if (!validName(n) || n === 'DEFAULT' || n === 'LOCAL') {
      throw err(400, 'Name must be 1–32 of A–Z, 0–9, _ (and not end in _LIMIT/_MODEL/_BASE_URL).');
    }
    return n;
  }

  static #limit(limit) {
    const s = String(limit ?? '').trim();
    if (s === '') return null;
    const n = Math.floor(Number(s));
    if (!(n > 0) || !Number.isFinite(n)) throw err(400, 'Limit must be a positive whole number.');
    return n;
  }

  static #url(baseUrl) {
    const url = KeyRing.#clean(baseUrl, 300);
    if (!url) return '';
    let u;
    try {
      u = new URL(url);
    } catch {
      throw err(400, 'Base URL is not a valid URL.');
    }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
      throw err(400, 'Base URL must be https (or http on localhost).');
    }
    return url;
  }

  /** The .env entry for a name: 'key', 'sub', or null. */
  #existing(name) {
    const v = this.vars();
    if (v[`AI_KEY_${name}`]) return 'key';
    if (v[`AI_SUB_${name}`]) return 'sub';
    return null;
  }

  #writeKey(name, key, lim, url, mdl) {
    this.#rewrite((lines) => {
      const kept = KeyRing.#without(lines, name);
      kept.push(`AI_KEY_${name}="${key}"`);
      if (lim != null) kept.push(`AI_KEY_${name}_LIMIT=${lim}`);
      if (url) kept.push(`AI_KEY_${name}_BASE_URL=${url}`);
      if (mdl) kept.push(`AI_KEY_${name}_MODEL=${mdl}`);
      return kept;
    });
  }

  /** Add a new API key. A name that is already used is refused, so nothing is overwritten by accident. */
  addKey({ name, apiKey, limit, baseUrl, model }) {
    const n = KeyRing.#name(name);
    const key = KeyRing.#clean(apiKey, 500);
    if (!key) throw err(400, 'API key is empty.');
    const url = KeyRing.#url(baseUrl);
    const lim = KeyRing.#limit(limit);
    const mdl = KeyRing.#clean(model, 200);
    if (this.#existing(n)) throw err(409, `${n} already exists. Edit it, or pick another name.`);
    this.#writeKey(n, key, lim, url, mdl);
    return n;
  }

  /** Change an API key's settings. An empty apiKey keeps the stored key. */
  updateKey({ name, apiKey, limit, baseUrl, model }) {
    const n = KeyRing.#name(name);
    if (this.#existing(n) !== 'key') throw err(404, `There is no API key called ${n}.`);
    const typed = KeyRing.#clean(apiKey, 500);
    const key = typed || this.vars()[`AI_KEY_${n}`];
    const url = KeyRing.#url(baseUrl);
    const lim = KeyRing.#limit(limit);
    const mdl = KeyRing.#clean(model, 200);
    this.#writeKey(n, key, lim, url, mdl);
    if (typed) this.#resetCooldown(n); // a new key deserves a fresh try
    return n;
  }

  #writeSub(name, kind, lim, mdl, bin) {
    this.#rewrite((lines) => {
      const kept = KeyRing.#without(lines, name);
      kept.push(`AI_SUB_${name}=${kind}`);
      if (lim != null) kept.push(`AI_SUB_${name}_LIMIT=${lim}`);
      if (mdl) kept.push(`AI_SUB_${name}_MODEL=${mdl}`);
      if (bin) kept.push(`AI_SUB_${name}_BIN=${bin}`);
      return kept;
    });
  }

  static #subArgs(kind, model) {
    if (!KINDS[kind]) throw err(400, `Type must be one of ${Object.keys(KINDS).join(', ')}.`);
    const mdl = String(model ?? '').trim();
    if (!validModel(mdl)) throw err(400, 'Model may only contain letters, digits and . _ : / -');
    return mdl;
  }

  /** Subscriptions: only the CLI type, a name, limit and model. The CLI path (_BIN) stays hand-edited. */
  addSubscription({ name, kind, limit, model }) {
    const n = KeyRing.#name(name);
    const mdl = KeyRing.#subArgs(kind, model);
    const lim = KeyRing.#limit(limit);
    if (this.#existing(n)) throw err(409, `${n} already exists. Edit it, or pick another name.`);
    this.#writeSub(n, kind, lim, mdl, '');
    return n;
  }

  /** Change a subscription's type, limit or model. A hand-set _BIN line is kept. */
  updateSubscription({ name, kind, limit, model }) {
    const n = KeyRing.#name(name);
    if (this.#existing(n) !== 'sub') throw err(404, `There is no subscription called ${n}.`);
    const v = this.vars();
    const k = kind || String(v[`AI_SUB_${n}`]).toLowerCase();
    const mdl = KeyRing.#subArgs(k, model);
    const lim = KeyRing.#limit(limit);
    this.#writeSub(n, k, lim, mdl, KeyRing.#clean(v[`AI_SUB_${n}_BIN`], 500));
    return n;
  }

  #resetCooldown(name) {
    const s = this.usage.keys[name];
    if (s) {
      s.cooldownUntil = 0;
      s.lastError = '';
      this.#save();
    }
  }

  removeKey(name) {
    if (name === 'DEFAULT') {
      this.#rewrite((lines) => lines.filter((l) => !/^\s*(?:export\s+)?AI_API_KEY\s*=/.test(l)));
    } else {
      if (!validName(name)) throw err(400, 'Bad key name.');
      if (!this.#existing(name)) throw err(404, `There is nothing called ${name}.`);
      const selected = this.vars().AI_KEY_SELECT === name;
      this.#rewrite((lines) => {
        const kept = KeyRing.#without(lines, name);
        // A default that points at nothing would silently fall back; say so explicitly
        return selected ? [...kept.filter((l) => !/^\s*(?:export\s+)?AI_KEY_SELECT\s*=/.test(l)), 'AI_KEY_SELECT=auto'] : kept;
      });
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
