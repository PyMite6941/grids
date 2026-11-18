// Subscriptions: use an AI plan the user already pays for (Claude Pro/Max, ChatGPT
// Plus/Pro, Google AI) through that vendor's own official CLI, which is signed in with
// the user's account. Grids only runs the CLI as a subprocess and reads its answer; it
// never reads or reuses the CLI's login tokens (that would break the vendors' terms).
//
// CLIs have no function calling, so the model answers in the JSON text protocol from
// shared/ai/text-protocol.md and parseTextReply() turns that into the usual actions.
//
// This only makes sense on the user's own machine: a hosted Grids must not resell one
// person's subscription to visitors, so the server only enables subscriptions on a
// loopback-bound server (or ALLOW_SUBSCRIPTIONS=1).

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,100}$/;
const TIMEOUT_MS = 180_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Supported CLIs. args() gets the model (validated) and a temp dir; the prompt always
 * goes over stdin so it never touches a command line or shell.
 */
export const KINDS = {
  claude: {
    label: 'Claude Pro / Max (Claude Code)',
    bin: 'claude',
    login: 'Run `claude` once and sign in with your Claude account.',
    // No tools: the model only writes the JSON answer. No session saved to disk.
    args: (model) => ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', ...(model ? ['--model', model] : [])],
    parse(stdout) {
      const j = JSON.parse(stdout);
      if (j.is_error) throw new Error(String(j.result || j.subtype || 'Claude Code returned an error'));
      const u = j.usage ?? {};
      return { text: String(j.result ?? ''), tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
    },
  },
  codex: {
    label: 'ChatGPT Plus / Pro (Codex CLI)',
    bin: 'codex',
    login: 'Run `codex login` and choose "Sign in with ChatGPT".',
    args: (model, dir) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', join(dir, 'last.txt'), ...(model ? ['--model', model] : []), '-'],
    parse(stdout, dir) {
      let text = '';
      try {
        text = readFileSync(join(dir, 'last.txt'), 'utf8');
      } catch {
        text = stdout;
      }
      return { text, tokens: 0 };
    },
  },
  gemini: {
    label: 'Google AI / Gemini (Gemini CLI)',
    bin: 'gemini',
    login: 'Run `gemini` once and choose "Login with Google".',
    // -p is appended to stdin; one word so it survives Windows .cmd argument handling
    args: (model) => ['-p', 'Answer.', '--output-format', 'json', ...(model ? ['-m', model] : [])],
    parse(stdout) {
      try {
        const j = JSON.parse(stdout);
        if (j.error) throw new Error(String(j.error.message ?? j.error));
        let tokens = 0;
        for (const m of Object.values(j.stats?.models ?? {})) tokens += m?.tokens?.total ?? 0;
        return { text: String(j.response ?? ''), tokens };
      } catch (e) {
        if (e instanceof SyntaxError) return { text: stdout, tokens: 0 }; // older CLI: plain text
        throw e;
      }
    },
  },
};

export const validModel = (m) => !m || MODEL_RE.test(m);

const installed = new Map();
/** Is the CLI on PATH? Cached per process. */
export function detect(bin) {
  if (!installed.has(bin)) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', timeout: 5000 });
    const hits = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    // On Windows `where` also lists extensionless sh shims (npm); only .exe/.cmd/.bat/.com can run
    const usable = process.platform === 'win32' ? hits.filter((h) => /\.(exe|cmd|bat|com)$/i.test(h)) : hits;
    installed.set(bin, usable[0] ?? null);
  }
  return installed.get(bin);
}

/** Classify CLI failures so the key ring can fail over (429) or flag a login problem (401). */
export function classifyFailure(text) {
  if (/rate.?limit|usage limit|limit reached|quota|resource_exhausted|\b429\b|too many requests|out of (credits|messages)/i.test(text)) return 429;
  if (/not (logged|signed) in|log ?in required|please (log|sign) ?in|unauthori[sz]ed|\b401\b|invalid api key|authenticat|must specify the \w*API_KEY/i.test(text)) return 401;
  return 500;
}

/** Pull the JSON object out of a model's text answer (tolerates fences and stray prose). */
export function parseTextReply(text) {
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(s.slice(start, end + 1));
      if (j && typeof j === 'object') {
        return {
          reply: typeof j.reply === 'string' ? j.reply : '',
          calls: Array.isArray(j.actions) ? j.actions : [],
        };
      }
    } catch {}
  }
  // Not JSON: treat it as a plain answer with no sheet changes
  return { reply: String(text).trim(), calls: [] };
}

/**
 * Run one subscription request. Resolves to {ok, status, text, tokens, detail}.
 * bin may be overridden per connection (AI_SUB_<NAME>_BIN, set by hand in .env only).
 */
export function runSubscription({ kind, model, bin }, prompt, { timeoutMs = TIMEOUT_MS } = {}) {
  const k = KINDS[kind];
  if (!k) return Promise.resolve({ ok: false, status: 400, detail: `Unknown subscription type ${kind}.` });
  if (!validModel(model)) return Promise.resolve({ ok: false, status: 400, detail: 'Bad model name.' });
  const exe = bin || k.bin;
  const dir = mkdtempSync(join(tmpdir(), 'grids-sub-'));
  return new Promise((resolve) => {
    const done = (r) => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      resolve(r);
    };
    // npm-installed CLIs are .cmd shims on Windows and must run through cmd.exe (.exe files
    // don't). Every argument is a fixed literal or a validated model name; the prompt goes
    // via stdin, never through a command line.
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(detect(exe) ?? exe);
    let child;
    try {
      child = spawn(viaCmd ? process.env.ComSpec || 'cmd.exe' : exe, viaCmd ? ['/d', '/s', '/c', exe, ...k.args(model, dir)] : k.args(model, dir), {
        cwd: dir, // empty dir: the CLI sees no project files
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      return done({ ok: false, status: 503, detail: `Could not start ${exe}: ${e.message}` });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      if (out.length < MAX_OUTPUT) out += c;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 20_000) err += c;
    });
    // On Windows kill the whole tree: killing cmd.exe alone would orphan the CLI
    const timer = setTimeout(() => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    }, timeoutMs);
    child.on('error', (e) =>
      done({ ok: false, status: 503, detail: e.code === 'ENOENT' ? `${exe} is not installed. ${k.login}` : `${exe} failed: ${e.message}` }),
    );
    const started = Date.now();
    const fail = (why) => {
      const status = classifyFailure(why);
      done({ ok: false, status, detail: `${k.label}: ${why}${status === 401 ? ` — ${k.login}` : ''}` });
    };
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal || Date.now() - started >= timeoutMs) return done({ ok: false, status: 504, detail: `${exe} timed out after ${timeoutMs / 1000}s.` });
      try {
        const { text, tokens } = k.parse(out, dir);
        if (code === 0 && text.trim()) return done({ ok: true, status: 200, text, tokens });
        fail((text || err || out).trim().slice(-400) || `exited with code ${code}`);
      } catch (e) {
        fail(`${e.message} ${err}`.trim().slice(-400));
      }
    });
    child.stdin.on('error', () => {}); // CLI may exit before reading everything
    child.stdin.end(prompt);
  });
}
