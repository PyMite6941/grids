// Workbook <-> .grid JSON (shared/FORMAT.md), CSV, and browser autosave.
// Everything coming from a file is treated as untrusted and sanitised here,
// so the rest of the app can assume clean keys and known format values.

import { normKey, NUM_FORMATS, parseRange, key } from '../engine/index.js';

export const MAX_INPUT_CHARS = 50_000;
const AUTOSAVE_KEY = 'grids:workbook:v1';
const HEX = /^#[0-9a-fA-F]{6}$/;
const ALIGN = new Set(['left', 'center', 'right']);
const COL = /^[A-Z]{1,3}$/;

/** Whitelist one cell's format object. Returns null if nothing valid remains. */
export function cleanFormat(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {};
  if (typeof f.bold === 'boolean') out.bold = f.bold;
  if (typeof f.italic === 'boolean') out.italic = f.italic;
  if (ALIGN.has(f.align)) out.align = f.align;
  if (NUM_FORMATS.includes(f.numFmt) && f.numFmt !== 'general') out.numFmt = f.numFmt;
  if (HEX.test(f.bg)) out.bg = f.bg.toLowerCase();
  if (HEX.test(f.color)) out.color = f.color.toLowerCase();
  return Object.keys(out).length ? out : null;
}

export function clampWidth(w) {
  const n = Math.round(Number(w));
  return Number.isFinite(n) ? Math.min(600, Math.max(40, n)) : null;
}

export function toFile(wb) {
  const sortedObj = (m) => Object.fromEntries([...m.entries()]);
  return {
    format: 'grids',
    version: 1,
    title: wb.title,
    sheets: [
      {
        name: 'Sheet1',
        cells: sortedObj(wb.cells),
        formats: sortedObj(wb.formats),
        colWidths: { ...wb.colWidths },
      },
    ],
  };
}

/** Parse + sanitise a .grid document. Throws Error with a user-facing message. */
export function fromFile(doc) {
  if (!doc || doc.format !== 'grids') throw new Error('Not a Grids file.');
  if (doc.version !== 1) throw new Error(`Unsupported Grids file version ${doc.version}.`);
  const sheet = Array.isArray(doc.sheets) ? doc.sheets[0] : null;
  if (!sheet || typeof sheet !== 'object') throw new Error('The file has no sheets.');

  const cells = new Map();
  for (const [k, v] of Object.entries(sheet.cells ?? {})) {
    const nk = normKey(k);
    if (nk && typeof v === 'string' && v !== '') cells.set(nk, v.slice(0, MAX_INPUT_CHARS));
  }
  const formats = new Map();
  for (const [k, v] of Object.entries(sheet.formats ?? {})) {
    const nk = normKey(k);
    const f = cleanFormat(v);
    if (nk && f) formats.set(nk, f);
  }
  const colWidths = {};
  for (const [c, w] of Object.entries(sheet.colWidths ?? {})) {
    const cw = clampWidth(w);
    if (COL.test(c) && cw) colWidths[c] = cw;
  }
  return { title: String(doc.title ?? 'Untitled').slice(0, 200), cells, formats, colWidths };
}

// ---- CSV (RFC 4180) ----

export function toCsv(rows) {
  const esc = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map((v) => esc(String(v ?? ''))).join(',')).join('\r\n');
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV text -> cell inputs. Cells starting with "=" are imported as text so a CSV can't smuggle in Python. */
export function csvToCells(text) {
  const cells = new Map();
  parseCsv(text).forEach((r, ri) =>
    r.forEach((v, ci) => {
      if (v === '') return;
      cells.set(key(ci, ri), v.startsWith('=') ? `'${v}` : v.slice(0, MAX_INPUT_CHARS));
    }),
  );
  return cells;
}

// ---- autosave ----

export function autosave(wb) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(toFile(wb)));
  } catch {
    // private mode / quota: autosave is a convenience, never fatal
  }
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? fromFile(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFileName(title) {
  return (title || 'Untitled').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'Untitled';
}

/** Iterate keys of a range string; null if invalid or larger than limit. */
export function rangeKeys(text, limit = 250_000) {
  const r = parseRange(String(text));
  if (!r || (r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1) > limit) return null;
  const out = [];
  for (let row = r.r1; row <= r.r2; row++) for (let c = r.c1; c <= r.c2; c++) out.push(key(c, row));
  return out;
}
