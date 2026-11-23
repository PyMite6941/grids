// The AI tools (shared/ai/tools.json) applied to a workbook state. Pure: no DOM, no
// undo — the caller wraps it (the app in one undo step, the MCP server in one save).
// Everything is validated here, because the actions come from a model.
//
// state: { title, cells: Map, formats: Map, colWidths: {} } — mutated in place.

import { normKey } from '../engine/index.js';
import { MAX_INPUT_CHARS, cleanFormat, clampWidth, rangeKeys } from './store.js';

/** Apply actions; returns a list of human-readable problems for the ones that were skipped. */
export function applyActions(st, actions) {
  const problems = [];
  for (const { name, args = {} } of actions) {
    switch (name) {
      case 'set_cells':
        for (const c of Array.isArray(args.cells) ? args.cells : []) {
          const k = normKey(c?.ref);
          if (!k || typeof c.input !== 'string') {
            problems.push(`set_cells: bad cell ${JSON.stringify(c?.ref)}`);
            continue;
          }
          if (c.input === '') st.cells.delete(k);
          else st.cells.set(k, c.input.slice(0, MAX_INPUT_CHARS));
        }
        break;
      case 'clear_range': {
        const keys = rangeKeys(args.range);
        if (!keys) {
          problems.push(`clear_range: bad range ${JSON.stringify(args.range)}`);
          break;
        }
        for (const k of keys) {
          st.cells.delete(k);
          if (args.formats) st.formats.delete(k);
        }
        break;
      }
      case 'format_range': {
        const keys = rangeKeys(args.range, 50_000);
        if (!keys) {
          problems.push(`format_range: bad range ${JSON.stringify(args.range)}`);
          break;
        }
        const { range, ...patch } = args;
        for (const k of keys) {
          const f = cleanFormat({ ...st.formats.get(k), ...patch });
          if (f) st.formats.set(k, f);
          else st.formats.delete(k);
        }
        break;
      }
      case 'set_column_width': {
        const col = String(args.column ?? '').toUpperCase();
        const w = clampWidth(args.width);
        if (!/^[A-Z]{1,3}$/.test(col) || !w) {
          problems.push('set_column_width: bad column/width');
          break;
        }
        st.colWidths[col] = w;
        break;
      }
      case 'set_title':
        if (typeof args.title === 'string' && args.title.trim()) st.title = args.title.trim().slice(0, 200);
        else problems.push('set_title: empty title');
        break;
      default:
        problems.push(`unknown action ${name}`);
    }
  }
  return problems;
}
