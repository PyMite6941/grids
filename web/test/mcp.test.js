import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, resolveFile, callTool, toolList } from '../mcp.js';
import { fromFile } from '../public/js/store.js';

const ws = () => mkdtempSync(join(tmpdir(), 'grids-mcp-'));
const call = (dir, name, args, id = 1) => handle(dir, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }).result;

test('MCP handshake and tool list mirror the shared AI tools', () => {
  const init = handle('x', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }).result;
  assert.equal(init.protocolVersion, '2025-03-26');
  assert.deepEqual(init.capabilities, { tools: {} });
  assert.equal(handle('x', { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const names = toolList().map((t) => t.name);
  const shared = JSON.parse(readFileSync(new URL('../../shared/ai/tools.json', import.meta.url), 'utf8')).map((t) => t.function.name);
  for (const n of shared) assert.ok(names.includes(n), n);
  for (const t of toolList()) if (shared.includes(t.name)) assert.ok(t.inputSchema.required.includes('file'));
  assert.equal(handle('x', { jsonrpc: '2.0', id: 9, method: 'nope' }).error.code, -32601);
});

test('MCP edits save a valid .grid that both apps can open', () => {
  const dir = ws();
  call(dir, 'create_workbook', { file: 'budget', title: 'Budget' });
  const r = call(dir, 'set_cells', { file: 'budget.grid', cells: [{ ref: 'b1', input: '2' }, { ref: 'B2', input: '=B1*21' }, { ref: 'C1', input: '=py 1+1' }] });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /B2: "=B1\*21" → 42/);
  assert.match(r.content[0].text, /Enable Python/);
  call(dir, 'format_range', { file: 'budget', range: 'B1:B2', bold: true, numFmt: '0.00' });
  const doc = JSON.parse(readFileSync(join(dir, 'budget.grid'), 'utf8'));
  assert.equal(doc.format, 'grids');
  const wb = fromFile(doc);
  assert.equal(wb.cells.get('B2'), '=B1*21');
  assert.deepEqual(wb.formats.get('B1'), { bold: true, numFmt: '0.00' });
  assert.match(call(dir, 'create_workbook', { file: 'budget' }).content[0].text, /already exists/);
  assert.match(call(dir, 'list_workbooks', {}).content[0].text, /budget\.grid/);
});

test('MCP stays inside its workspace', () => {
  const dir = ws();
  for (const bad of ['../x', String.raw`..\x`, 'a/b', String.raw`C:\x.grid`, '/etc/passwd', '', '.hidden']) {
    assert.throws(() => resolveFile(dir, bad), /Bad workbook name/, bad);
  }
  assert.ok(resolveFile(dir, 'Q1 report (v2)').endsWith('Q1 report (v2).grid'));
  writeFileSync(join(dir, 'broken.grid'), '{nope');
  assert.equal(call(dir, 'read_sheet', { file: 'broken' }).isError, true);
  assert.equal(call(dir, 'read_sheet', { file: 'missing' }).isError, true);
});

test('MCP runs over stdio', () => {
  const dir = ws();
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_workbook', arguments: { file: 't' } } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const p = spawnSync(process.execPath, [fileURLToPath(new URL('../mcp.js', import.meta.url)), '--dir', dir], { input, encoding: 'utf8' });
  const lines = p.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].result.serverInfo.name, 'grids');
  assert.match(lines[1].result.content[0].text, /Created/);
});
