// A1-style addressing. Columns and rows are 0-based internally.

export const MAX_COLS = 18278; // ZZZ
export const MAX_ROWS = 1_000_000;
export const MAX_RANGE_CELLS = 250_000;

export function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function indexToCol(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export const key = (col, row) => indexToCol(col) + (row + 1);

const REF = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/;

/** "B12" / "$B$12" -> {col: 1, row: 11}; null if not a valid reference. */
export function parseRef(text) {
  const m = REF.exec(text.trim());
  if (!m) return null;
  const col = colToIndex(m[1]);
  const row = Number(m[2]) - 1;
  if (col >= MAX_COLS || row >= MAX_ROWS) return null;
  return { col, row };
}

/** "A1:C3" (or a single "A1") -> normalised {c1, r1, c2, r2}; null if invalid. */
export function parseRange(text) {
  const parts = text.split(':');
  if (parts.length > 2) return null;
  const a = parseRef(parts[0]);
  const b = parts.length === 2 ? parseRef(parts[1]) : a;
  if (!a || !b) return null;
  return {
    c1: Math.min(a.col, b.col),
    r1: Math.min(a.row, b.row),
    c2: Math.max(a.col, b.col),
    r2: Math.max(a.row, b.row),
  };
}

/** Normalise user/AI supplied keys: "$b$3" -> "B3". Returns null if invalid. */
export function normKey(text) {
  const r = parseRef(String(text));
  return r ? key(r.col, r.row) : null;
}
