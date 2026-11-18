// Whole-sheet evaluation. Pure: (inputs, python results) -> values.
// The Java twin is desktop/src/grids/engine/Evaluator.java — keep the algorithm identical.
//
// Algorithm
//   1. Classify every non-empty input (literal / formula / python).
//   2. Pass: evaluate every cell with memoised recursion; cycles -> #CIRC!.
//      Empty cells read the spill map produced by the *previous* pass.
//   3. Place array results (anchors) in row-major order. A target that has input,
//      or was already claimed, blocks the anchor -> #SPILL!.
//   4. If the spill map / blocked set differ from what this pass read, run again
//      (bounded). Spills only depend on other spills in pathological sheets, so
//      this settles in 1–3 passes in practice.

import { parseFormula, ParseError } from './parser.js';
import { key, parseRef, MAX_COLS, MAX_ROWS } from './refs.js';
import { err, isErr, isArr, GridError, parseNumber, toNumber, toText, compare, scalar, num } from './values.js';
import { FUNCTIONS } from './functions.js';

const PY_PREFIX = /^=py[ \t\r\n]/i;
const MAX_PASSES = 8;

export const isPythonInput = (input) => typeof input === 'string' && PY_PREFIX.test(input);

/** Python source of a "=py ..." cell (prefix removed; the runtime dedents). */
export const pythonCode = (input) => input.slice(3);

const parseCache = new Map();

/** Classify a raw cell input. Returns null for empty. */
export function classify(input) {
  if (input === null || input === undefined || input === '') return null;
  if (isPythonInput(input)) return { kind: 'python', code: pythonCode(input) };
  if (input.startsWith('=')) {
    let c = parseCache.get(input);
    if (!c) {
      try {
        c = { kind: 'formula', ast: parseFormula(input.slice(1)) };
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        c = { kind: 'formula', error: err('#ERROR!', e.message) };
      }
      if (parseCache.size > 5000) parseCache.clear();
      parseCache.set(input, c);
    }
    return c;
  }
  if (input.startsWith("'")) return { kind: 'literal', value: input.slice(1) };
  const n = parseNumber(input);
  if (n !== null) return { kind: 'literal', value: n };
  const u = input.trim().toUpperCase();
  if (u === 'TRUE' || u === 'FALSE') return { kind: 'literal', value: u === 'TRUE' };
  return { kind: 'literal', value: input };
}

/** Convert JSON-ish values (from Python / fixtures / files) into engine values. */
export function fromPlain(v) {
  if (v === undefined) return null;
  if (isArr(v)) return v.map((row) => (isArr(row) ? row.map(fromPlain) : [fromPlain(row)]));
  if (v && typeof v === 'object' && typeof v.error === 'string') return new GridError(v.error, v.message ?? '');
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return v;
  return String(v);
}

const rowMajor = (a, b) => {
  const ra = parseRef(a);
  const rb = parseRef(b);
  return ra.row - rb.row || ra.col - rb.col;
};

/** Pad ragged rows and collapse 1x1 arrays. */
function normaliseArray(v) {
  if (!isArr(v)) return v;
  if (v.length === 0) return null;
  const width = v.reduce((w, r) => Math.max(w, r.length), 0);
  if (width === 0) return null;
  const g = v.map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill(null)]));
  return g.length === 1 && width === 1 ? g[0][0] : g;
}

function runPass(classified, python, prev) {
  const memo = new Map();
  const visiting = new Set();
  const arrays = new Map();

  function cellValue(k) {
    if (memo.has(k)) return memo.get(k);
    const c = classified.get(k);
    if (!c) {
      const s = prev.spill.get(k);
      return s ? s.value : null;
    }
    if (visiting.has(k)) return err('#CIRC!', 'Circular reference');
    visiting.add(k);
    let v = normaliseArray(compute(c, k));
    visiting.delete(k);
    if (isArr(v)) {
      arrays.set(k, v);
      v = prev.blocked.has(k) ? err('#SPILL!', 'Spill range is not empty') : v[0][0];
    }
    memo.set(k, v);
    return v;
  }

  function compute(c, k) {
    if (c.kind === 'literal') return c.value;
    if (c.kind === 'python') {
      return python.has(k) ? python.get(k) : err('#BUSY!', 'Python has not run for this cell yet');
    }
    if (c.error) return c.error;
    return ev(c.ast);
  }

  function rangeArray(n) {
    const out = [];
    for (let r = n.r1; r <= n.r2; r++) {
      const row = [];
      for (let col = n.c1; col <= n.c2; col++) row.push(cellValue(key(col, r)));
      out.push(row);
    }
    return out;
  }

  function ev(n) {
    switch (n.t) {
      case 'num':
      case 'str':
      case 'bool':
        return n.v;
      case 'ref':
        return cellValue(key(n.col, n.row));
      case 'range':
        return rangeArray(n);
      case 'neg': {
        const x = toNumber(scalar(ev(n.e)));
        return isErr(x) ? x : -x;
      }
      case 'pct': {
        const x = toNumber(scalar(ev(n.e)));
        return isErr(x) ? x : x / 100;
      }
      case 'call': {
        const fn = FUNCTIONS[n.name];
        if (!fn) return err('#NAME?', `Unknown function ${n.name}`);
        const args = n.args.map((a) => (a.t === 'ref' ? [[ev(a)]] : ev(a)));
        return fn(args);
      }
      case 'bin':
        return binary(n.op, scalar(ev(n.l)), scalar(ev(n.r)));
    }
    throw new Error(`unknown node ${n.t}`);
  }

  function binary(op, a, b) {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (op === '&') return toText(a) + toText(b);
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      const c = compare(a, b);
      return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
    }
    const x = toNumber(a);
    if (isErr(x)) return x;
    const y = toNumber(b);
    if (isErr(y)) return y;
    switch (op) {
      case '+': return num(x + y);
      case '-': return num(x - y);
      case '*': return num(x * y);
      case '/': return y === 0 ? err('#DIV/0!') : num(x / y);
      case '^': return num(Math.pow(x, y));
    }
    throw new Error(`unknown operator ${op}`);
  }

  for (const k of classified.keys()) cellValue(k);

  // Place spills, row-major so the winner of a collision is deterministic.
  const spill = new Map();
  const blocked = new Set();
  for (const anchor of [...arrays.keys()].sort(rowMajor)) {
    const g = arrays.get(anchor);
    const a = parseRef(anchor);
    const targets = [];
    let ok = a.row + g.length <= MAX_ROWS && a.col + g[0].length <= MAX_COLS;
    for (let i = 0; ok && i < g.length; i++) {
      for (let j = 0; j < g[i].length; j++) {
        if (i === 0 && j === 0) continue;
        const t = key(a.col + j, a.row + i);
        if (classified.has(t) || spill.has(t)) { ok = false; break; }
        targets.push([t, g[i][j]]);
      }
    }
    if (!ok) {
      blocked.add(anchor);
      memo.set(anchor, err('#SPILL!', 'Spill range is not empty'));
      continue;
    }
    memo.set(anchor, g[0][0]);
    for (const [t, value] of targets) spill.set(t, { anchor, value });
  }
  return { memo, spill, blocked };
}

function sameValue(a, b) {
  if (isErr(a) || isErr(b)) return isErr(a) && isErr(b) && a.code === b.code;
  return a === b;
}

function sameState(a, b) {
  if (a.spill.size !== b.spill.size || a.blocked.size !== b.blocked.size) return false;
  for (const x of a.blocked) if (!b.blocked.has(x)) return false;
  for (const [k, s] of a.spill) {
    const o = b.spill.get(k);
    if (!o || o.anchor !== s.anchor || !sameValue(o.value, s.value)) return false;
  }
  return true;
}

/**
 * Evaluate a sheet.
 * @param cells   Map or object of "A1" -> raw input string
 * @param opts.python Map of "A1" -> engine value (scalar | GridError | 2-D array) for Python cells
 * @returns {{values: Map<string, any>, spills: Map<string, string>}}
 *          values holds every non-empty cell (including spill targets);
 *          spills maps each spill target to its anchor.
 */
export function evaluateSheet(cells, opts = {}) {
  const python = opts.python ?? new Map();
  const classified = new Map();
  const entries = cells instanceof Map ? cells.entries() : Object.entries(cells);
  for (const [k, input] of entries) {
    const c = classify(input);
    if (c) classified.set(k, c);
  }

  let prev = { spill: new Map(), blocked: new Set() };
  let res;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    res = runPass(classified, python, prev);
    if (sameState(res, prev)) break;
    prev = res;
  }

  const values = new Map(res.memo);
  const spills = new Map();
  for (const [t, s] of res.spill) {
    values.set(t, s.value);
    spills.set(t, s.anchor);
  }
  return { values, spills };
}
