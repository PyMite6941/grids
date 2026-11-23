#!/usr/bin/env node
// Grids setup and uninstall. Zero dependencies; everything is optional and asked first.
//
//   npm run setup        choose where keys live, add/edit/remove keys and subscriptions,
//                        and (if you want) connect an outside AI through MCP
//   npm run uninstall    undo all of that; deleting files is always asked separately
//
// Keys are typed with the echo hidden, written only to the .env, and never printed.

import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, rmdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KeyRing, envFilePath, repoEnvPath, homeEnvPath, inSyncedFolder, secureFile } from './lib/keyring.js';
import { KINDS, detect } from './lib/subscriptions.js';

const MCP_JS = fileURLToPath(new URL('mcp.js', import.meta.url));
const STATE = join(homedir(), '.grids', 'install.json');
const DEFAULT_WORKSPACE = join(homedir(), 'Grids');
const REPO = fileURLToPath(new URL('..', import.meta.url));

// ---------- small helpers (exported for tests) ----------

export function readState(path = STATE) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(state, path = STATE) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Move the key file (and its usage file) to `to`. The copy is written and secured before
 * the original is deleted, so a failure never loses keys.
 */
export function moveKeyFile(from, to) {
  if (from === to) return false;
  if (existsSync(to)) throw new Error(`${to} already exists; merge the two files by hand first.`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  secureFile(to);
  if (readFileSync(to, 'utf8') !== readFileSync(from, 'utf8')) throw new Error('Copy check failed; nothing was deleted.');
  const usageFrom = join(dirname(from), '.grids-usage.json');
  if (existsSync(usageFrom) && !existsSync(join(dirname(to), '.grids-usage.json'))) renameSync(usageFrom, join(dirname(to), '.grids-usage.json'));
  unlinkSync(from);
  return true;
}

/** The JSON other MCP clients (Claude Desktop, Cursor, …) want in their config file. */
export function mcpConfigSnippet(workspace) {
  return JSON.stringify({ mcpServers: { grids: { command: 'node', args: [MCP_JS, '--dir', workspace] } } }, null, 2);
}

/** Run a CLI that may be a Windows .cmd shim (those need cmd.exe; quote every argument). */
function runCli(bin, args) {
  const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  if (shim) {
    const q = (a) => `"${String(a).replace(/"/g, '')}"`;
    return spawnSync(`${q(bin)} ${args.map(q).join(' ')}`, { shell: true, encoding: 'utf8', windowsHide: true });
  }
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
}

// ---------- prompts ----------

// Lines are queued so piped input (scripts, tests) works as well as typing. While a
// secret is being typed, readline's echo is suppressed.
let io;
const queue = [];
let waiting = null;
let closed = false;
let muted = false;

function openInput() {
  io = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const write = io._writeToOutput?.bind(io);
  if (write) io._writeToOutput = (s) => (muted ? undefined : write(s));
  io.on('line', (l) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(l);
    } else queue.push(l);
  });
  io.on('close', () => {
    closed = true;
    if (waiting) waiting('');
  });
}

function nextLine(prompt) {
  process.stdout.write(prompt);
  if (queue.length) return Promise.resolve(queue.shift());
  if (closed) return Promise.resolve('');
  return new Promise((res) => (waiting = res));
}

const ask = async (q, def = '') => {
  const a = (await nextLine(def ? `${q} [${def}] ` : `${q} `)).trim();
  if (!process.stdin.isTTY) process.stdout.write('\n');
  return a || def;
};
const askSecret = async (q) => {
  muted = true;
  const a = await nextLine(q);
  muted = false;
  process.stdout.write('\n');
  return a.trim();
};
const yes = async (q, def = false) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
const say = (s = '') => console.log(s);

function listConnections(ring) {
  const keys = ring.summary();
  if (!keys.length) return say('  (nothing connected yet)');
  for (const k of keys) {
    const what = k.type === 'sub' ? `subscription · ${k.label}${k.installed ? '' : ' (CLI not found)'}` : `API key ${k.hint} · ${k.host}`;
    say(`  ${k.name.padEnd(12)} ${what} · ${k.model}${k.limit ? ` · limit ${k.limit}/day` : ''}`);
  }
  say(`  default: ${ring.defaultSelection()}`);
}

async function tryEdit(fn) {
  try {
    const n = fn();
    say(`  Saved${n ? ` ${n}` : ''}.`);
  } catch (e) {
    say(`  ${e.message}`);
  }
}

// ---------- setup ----------

async function chooseLocation() {
  let path = envFilePath();
  const home = homeEnvPath();
  say(`Key file: ${path}${existsSync(path) ? '' : ' (not created yet)'}`);
  if (process.env.GRIDS_ENV_FILE) return say('  (set by GRIDS_ENV_FILE; leaving it there)');
  if (path === home) return say('  Good: outside the project folder.');
  const synced = inSyncedFolder(path);
  if (synced) say('  Warning: this folder is cloud-synced, so the keys would be uploaded with it.');
  if (!(await yes(`Keep keys in ${home} instead (outside the project${synced ? ' and the synced folder' : ''})?`, synced))) return;
  if (existsSync(path)) {
    moveKeyFile(path, home);
    say(`  Moved to ${home}.`);
  } else {
    mkdirSync(dirname(home), { recursive: true });
    writeFileSync(home, '# Grids AI keys — local only, never commit or share this file. See shared/KEYS.md.\n', { mode: 0o600 });
    secureFile(home);
    say(`  Created ${home}.`);
  }
  path = home;
}

async function connections() {
  for (;;) {
    const ring = new KeyRing();
    say('\nAI connections:');
    listConnections(ring);
    const c = (await ask('\n[a]dd API key, add [s]ubscription, [e]dit, [r]emove, set [d]efault, [Enter] continue:')).toLowerCase();
    if (!c) return;
    if (c === 'a') {
      say('  Any OpenAI-compatible provider. Leave optional fields empty for the defaults (Groq).');
      const name = await ask('  Name (A–Z, 0–9, _):', 'GROQ');
      const apiKey = await askSecret('  API key (hidden): ');
      const limit = await ask('  Daily request limit (optional):');
      const baseUrl = await ask('  Base URL (optional, e.g. https://openrouter.ai/api/v1):');
      const model = await ask('  Model (optional):');
      await tryEdit(() => ring.addKey({ name, apiKey, limit, baseUrl, model }));
    } else if (c === 's') {
      const kinds = Object.entries(KINDS);
      kinds.forEach(([k, v], i) => say(`  ${i + 1}. ${v.label}${detect(v.bin) ? '' : ' (CLI not installed)'} — sign in: ${v.login}`));
      const pick = kinds[Number(await ask('  Which?', '1')) - 1];
      if (!pick) continue;
      const name = await ask('  Name:', pick[0].toUpperCase());
      const limit = await ask('  Daily request limit (optional):');
      const model = await ask('  Model (optional, CLI default if empty):');
      await tryEdit(() => ring.addSubscription({ name, kind: pick[0], limit, model }));
    } else if (c === 'e') {
      const name = (await ask('  Edit which name?')).toUpperCase();
      const k = ring.summary().find((x) => x.name === name);
      if (!k || !k.editable) {
        say('  No editable connection by that name.');
        continue;
      }
      say('  Press Enter to keep a value; type - to clear it.');
      const keep = (typed, old) => (typed === '-' ? '' : typed || old);
      const limit = keep(await ask('  Daily request limit:', k.config.limit), '');
      const model = keep(await ask('  Model:', k.config.model), '');
      if (k.type === 'sub') await tryEdit(() => ring.updateSubscription({ name, kind: k.kind, limit, model }));
      else {
        const baseUrl = keep(await ask('  Base URL:', k.config.baseUrl), '');
        const apiKey = await askSecret(`  New API key (hidden; Enter keeps ${k.hint}): `);
        await tryEdit(() => ring.updateKey({ name, apiKey, limit, baseUrl, model }));
      }
    } else if (c === 'r') {
      const name = (await ask('  Remove which name?')).toUpperCase();
      if (name && (await yes(`  Really remove ${name}? An API key is deleted from the file`))) await tryEdit(() => ring.removeKey(name));
    } else if (c === 'd') {
      const sel = await ask('  Default connection (a name, or auto):', 'auto');
      await tryEdit(() => ring.setSelection(sel === 'auto' ? 'auto' : sel.toUpperCase()));
    }
  }
}

async function connectMcp(state) {
  say('\nOutside AIs (Claude Code, Claude Desktop, Cursor, …) can also read and edit your');
  say('workbooks directly through the Grids MCP server. It only touches .grid files in one folder.');
  if (!(await yes('Set that up?', false))) return;
  const workspace = await ask('  Workbook folder:', state.workspace || DEFAULT_WORKSPACE);
  mkdirSync(workspace, { recursive: true });
  state.workspace = workspace;
  const claude = detect('claude');
  if (claude && (await yes('  Claude Code found. Register Grids with it (claude mcp add, user scope)?', true))) {
    runCli(claude, ['mcp', 'remove', '--scope', 'user', 'grids']); // replace an older registration
    const r = runCli(claude, ['mcp', 'add', '--scope', 'user', 'grids', '--', process.execPath, MCP_JS, '--dir', workspace]);
    if (r.status === 0) {
      state.claudeCode = true;
      say('  Registered. In Claude Code, /mcp shows "grids".');
    } else say(`  claude mcp add failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  say('\n  For other MCP clients, add this to their config (Claude Desktop: Settings → Developer → Edit Config):');
  say(mcpConfigSnippet(workspace).replace(/^/gm, '    '));
}

async function setup() {
  say('Grids setup — everything here is optional. Ctrl+C quits at any time.\n');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) say(`Note: Grids needs Node 22 or newer (this is ${process.versions.node}).`);
  for (const [bin, why] of [['java', 'desktop app'], [process.platform === 'win32' ? 'python' : 'python3', 'desktop Python cells']]) {
    if (!detect(bin)) say(`Note: ${bin} not found (only needed for the ${why}).`);
  }
  const state = readState();
  await chooseLocation();
  await connections();
  await connectMcp(state);
  state.installedAt = new Date().toISOString();
  writeState(state);
  say('\nDone. Start the website with: npm start   (http://127.0.0.1:5173)');
  say('To undo everything later, run uninstall.cmd (Windows) or uninstall.sh in the Grids folder.');
}

// ---------- uninstall ----------

async function uninstall() {
  say('Grids uninstall. Nothing is deleted without asking.\n');
  const state = readState();
  const claude = detect('claude');
  if (claude) {
    const r = runCli(claude, ['mcp', 'remove', '--scope', 'user', 'grids']);
    say(r.status === 0 ? 'Removed the Grids MCP server from Claude Code.' : 'Claude Code: no Grids MCP server registered.');
  }
  say('If you added Grids to another MCP client (Claude Desktop, Cursor…), delete its "grids" entry there.');

  const keyFiles = [...new Set([process.env.GRIDS_ENV_FILE, repoEnvPath(), homeEnvPath()].filter((p) => p && existsSync(p)))];
  for (const f of keyFiles) {
    if (await yes(`\nDelete the key file ${f}? Your API keys in it are gone for good`, false)) {
      unlinkSync(f);
      const usage = join(dirname(f), '.grids-usage.json');
      if (existsSync(usage)) unlinkSync(usage);
      say('  Deleted (and its usage counts). Revoke the keys at each provider if you no longer use them.');
    } else say('  Kept.');
  }
  if (state.workspace && existsSync(state.workspace)) say(`\nYour workbooks in ${state.workspace} were left alone. Delete that folder yourself if you want them gone.`);

  const build = join(REPO, 'desktop', 'build');
  if (existsSync(build) && !(await yes(`\nDelete the desktop build output (${build})?`, true))) say('  Kept.');
  else if (existsSync(build)) {
    spawnSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', build] : ['-rf', build], { windowsHide: true });
    say(existsSync(build) ? '  Could not delete it (in use?).' : '  Deleted.');
  }

  try {
    unlinkSync(STATE);
  } catch {}
  try {
    if (!readdirSync(dirname(STATE)).length) rmdirSync(dirname(STATE));
  } catch {}
  say('\nThe website also autosaves the open workbook in your browser: use File → New there, or clear');
  say('site data for 127.0.0.1:5173, to remove it.');
  // uninstall.cmd / uninstall.sh ask about deleting the folder themselves
  if (!process.argv.includes('--from-script')) say(`\nTo finish, delete the Grids folder itself (or run uninstall.cmd / uninstall.sh, which offers to): ${REPO}`);
}

// ---------- entry ----------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\//g, process.platform === 'win32' ? '\\' : '/')) {
  openInput();
  const run = process.argv.includes('--uninstall') ? uninstall : setup;
  run()
    .catch((e) => {
      console.error(`\nSetup stopped: ${e.message}`);
      process.exitCode = 1;
    })
    .finally(() => io.close());
}
