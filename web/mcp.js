#!/usr/bin/env node
// Grids MCP server: lets an outside AI (Claude Code, Claude Desktop, Cursor, any MCP
// client) read and edit .grid workbooks directly. Zero dependencies: JSON-RPC 2.0 over
// stdio, one message per line.
//
// It exposes the same edit tools as the in-app AI (shared/ai/tools.json), applied by the
// same validated code (public/js/actions.js), each with an extra `file` argument.
//
// Safety:
// - Files live in ONE workspace folder (--dir, else GRIDS_WORKSPACE, else ~/Grids).
//   Names are plain file names; no paths, so the AI can't reach anything else.
// - Python cells are never run here. A file opened in either app is untrusted until the
//   user clicks Enable Python, so Python an AI writes is reviewed before it runs.
// - stdout carries protocol messages only; logs go to stderr.

import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { evaluateSheet, formatValue, isPythonInput } from './public/engine/index.js';
import { toFile, fromFile } from './public/js/store.js';
import { applyActions } from './public/js/actions.js';

const SHARED = new URL('../shared/', import.meta.url);
const EDIT_TOOLS = JSON.parse(readFileSync(new URL('ai/tools.json', SHARED), 'utf8')).map((t) => t.function);
const VERSION = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LISTED_CELLS = 2000;

export function workspaceDir(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf('--dir');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : env.GRIDS_WORKSPACE || join(homedir(), 'Grids');
}

class ToolError extends Error {}

/** A workbook name -> a path inside the workspace. Plain names only: no folders, no '..'. */
export function resolveFile(dir, name) {
  let n = String(name ?? '').trim();
  if (!n.toLowerCase().endsWith('.grid')) n += '.grid';
  if (!/^[\w][\w .()-]{0,120}\.grid$/i.test(n) || n.includes('..')) {
    throw new ToolError(`Bad workbook name ${JSON.stringify(name)}: use a plain file name like "budget" or "budget.grid".`);
  }
  return join(dir, n);
}

function load(path) {
  if (!existsSync(path)) throw new ToolError(`No workbook called ${JSON.stringify(path.split(/[\\/]/).pop())}. Use list_workbooks or create_workbook.`);
  if (statSync(path).size > MAX_FILE_BYTES) throw new ToolError('That workbook is larger than 5 MB.');
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ToolError('That file is not valid JSON.');
  }
  try {
    return fromFile(doc);
  } catch (e) {
    throw new ToolError(e.message);
  }
}

function save(path, wb) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    unlinkSync(tmp);
  } catch {}
  writeFileSync(tmp, JSON.stringify(toFile(wb), null, 2) + '\n');
  renameSync(tmp, path);
}

const rowMajor = (a, b) => {
  const [, ca, ra] = /^([A-Z]+)(\d+)$/.exec(a);
  const [, cb, rb] = /^([A-Z]+)(\d+)$/.exec(b);
  return Number(ra) - Number(rb) || ca.length - cb.length || (ca < cb ? -1 : ca > cb ? 1 : 0);
};

/** Text view of a workbook: each cell's input and the value it shows (Python cells: not run). */
export function describe(wb) {
  const { values } = evaluateSheet(wb.cells);
  const keys = [...wb.cells.keys()].sort(rowMajor);
  const lines = [`Title: ${wb.title}`, `Non-empty cells: ${keys.length}${keys.length > MAX_LISTED_CELLS ? ` (first ${MAX_LISTED_CELLS} shown)` : ''}. Format: REF: "input" → shown value`];
  for (const k of keys.slice(0, MAX_LISTED_CELLS)) {
    const input = wb.cells.get(k);
    const shown = isPythonInput(input) ? '(Python: runs in the app)' : formatValue(values.get(k), wb.formats.get(k)?.numFmt);
    lines.push(`${k}: ${JSON.stringify(input)}${String(shown) === input ? '' : ` → ${shown}`}`);
  }
  // Spilled values have no input of their own; list them so the AI sees array results
  const spilled = [...values.keys()].filter((k) => !wb.cells.has(k)).sort(rowMajor).slice(0, 200);
  if (spilled.length) lines.push(`Spilled values: ${spilled.map((k) => `${k}=${formatValue(values.get(k))}`).join(', ')}`);
  if (Object.keys(wb.colWidths).length) lines.push(`Column widths: ${JSON.stringify(wb.colWidths)}`);
  return lines.join('\n');
}

const fileProp = { file: { type: 'string', description: 'Workbook name in the Grids workspace, e.g. "budget" or "budget.grid"' } };

export function toolList() {
  return [
    { name: 'list_workbooks', description: 'List the .grid workbooks in the Grids workspace folder.', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_sheet', description: 'Read a workbook: every cell\'s raw input and its computed value. Call this before editing.', inputSchema: { type: 'object', properties: fileProp, required: ['file'] } },
    {
      name: 'create_workbook',
      description: 'Create a new, empty workbook. Fails if one with that name exists.',
      inputSchema: { type: 'object', properties: { ...fileProp, title: { type: 'string' } }, required: ['file'] },
    },
    { name: 'formula_reference', description: 'The Grids formula language: functions, operators, coercion and spilling. Only these functions exist.', inputSchema: { type: 'object', properties: {} } },
    ...EDIT_TOOLS.map((t) => ({
      name: t.name,
      description: `${t.description} Saves the workbook immediately.`,
      inputSchema: { ...t.parameters, properties: { ...fileProp, ...t.parameters.properties }, required: ['file', ...(t.parameters.required ?? [])] },
    })),
  ];
}

export function callTool(dir, name, args = {}) {
  if (name === 'list_workbooks') {
    if (!existsSync(dir)) return `The workspace ${dir} is empty.`;
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.grid'));
    return files.length ? `Workspace: ${dir}\n${files.join('\n')}` : `The workspace ${dir} has no workbooks yet.`;
  }
  if (name === 'formula_reference') return readFileSync(new URL('FORMULAS.md', SHARED), 'utf8');
  if (name === 'create_workbook') {
    const path = resolveFile(dir, args.file);
    if (existsSync(path)) throw new ToolError(`${path.split(/[\\/]/).pop()} already exists.`);
    mkdirSync(dir, { recursive: true });
    const title = String(args.title ?? '').trim().slice(0, 200) || path.split(/[\\/]/).pop().replace(/\.grid$/i, '');
    save(path, { title, cells: new Map(), formats: new Map(), colWidths: {} });
    return `Created ${path}.`;
  }
  if (name === 'read_sheet') return describe(load(resolveFile(dir, args.file)));
  if (EDIT_TOOLS.some((t) => t.name === name)) {
    const path = resolveFile(dir, args.file);
    const wb = load(path);
    const { file, ...rest } = args;
    const problems = applyActions(wb, [{ name, args: rest }]);
    save(path, wb);
    const python = name === 'set_cells' && (rest.cells ?? []).some((c) => isPythonInput(c?.input));
    return [
      problems.length ? `Saved, but skipped: ${problems.join('; ')}` : 'Saved.',
      python ? 'Python cells were written; they run only after the user opens the file and clicks Enable Python.' : '',
      '',
      describe(wb),
    ].filter((l, i) => l || i > 1).join('\n');
  }
  throw new ToolError(`Unknown tool ${name}.`);
}

/** Handle one JSON-RPC message; returns the response object, or null for notifications. */
export function handle(dir, msg) {
  const { id, method, params } = msg ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
  if (id === undefined) return null; // notifications (initialized, cancelled) need no answer
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'grids', version: VERSION },
        instructions: `Grids spreadsheets in ${dir}. read_sheet before editing; write formulas rather than computed numbers; call formula_reference if unsure a function exists (use Python cells "=py ..." for anything else).`,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolList() });
    case 'tools/call':
      try {
        return reply({ content: [{ type: 'text', text: callTool(dir, params?.name, params?.arguments ?? {}) }] });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('grids-mcp:', e);
        return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'Internal error; see the server log.' }], isError: true });
      }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

// Run as a server only when executed directly (tests import the functions above)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = workspaceDir();
  console.error(`Grids MCP server: workspace ${dir}`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let out;
    try {
      out = handle(dir, JSON.parse(line));
    } catch {
      out = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    }
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
