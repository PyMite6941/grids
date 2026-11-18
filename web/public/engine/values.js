// Value model shared by the evaluator, the functions and the UI.
// Scalars are plain JS: number | string | boolean | null (empty).
// Errors are GridError instances. Arrays are 2-D JS arrays (rows of scalars).

export class GridError {
  constructor(code, message = '') {
    this.code = code;
    this.message = message;
  }
  toString() {
    return this.code;
  }
}

export const err = (code, message) => new GridError(code, message);
export const isErr = (v) => v instanceof GridError;
export const isArr = (v) => Array.isArray(v);

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Parse a numeric string the same way literals and coercion do. Returns null if not numeric. */
export function parseNumber(text) {
  const s = text.trim();
  if (NUMERIC.test(s)) return Number(s);
  if (s.endsWith('%') && NUMERIC.test(s.slice(0, -1).trim())) return Number(s.slice(0, -1).trim()) / 100;
  return null;
}

/** NaN / Infinity must never leak into the sheet. */
export function num(n) {
  return Number.isFinite(n) ? n : err('#NUM!');
}

export function toNumber(v) {
  if (isErr(v)) return v;
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = parseNumber(v);
    return n === null || v.trim() === '' ? err('#VALUE!') : n;
  }
  return err('#VALUE!');
}

export function toBool(v) {
  if (isErr(v)) return v;
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const u = v.trim().toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
  }
  return err('#VALUE!');
}

/**
 * Shortest text form of a number: 3 not 3.0, 0.5, 0.30000000000000004.
 * Java's Engine mirrors this (see Values.numberToText) so `&` agrees across engines.
 */
export function numberToText(n) {
  return String(n);
}

export function toText(v) {
  if (isErr(v)) return v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return numberToText(v);
  return String(v);
}

const TYPE_RANK = { number: 0, string: 1, boolean: 2 };

/** Three-way compare used by = < > and SORT. Strings compare case-insensitively. */
export function compare(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'number' ? 0 : typeof b === 'string' ? '' : false;
  if (b === null) b = typeof a === 'number' ? 0 : typeof a === 'string' ? '' : false;
  const ta = TYPE_RANK[typeof a];
  const tb = TYPE_RANK[typeof b];
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (typeof a === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 1x1 arrays collapse to their value; bigger arrays are not allowed in a scalar position. */
export function scalar(v) {
  if (!isArr(v)) return v;
  if (v.length === 1 && v[0].length === 1) return v[0][0];
  return err('#VALUE!', 'A range was used where a single value was expected');
}
