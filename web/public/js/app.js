// Grids — app controller. Owns workbook state, recalculation, the Python pump,
// undo/redo, the toolbar/menus, files and the clipboard. The grid view, the AI
// panel and the Python runner are separate modules that talk to this.

import { evaluateSheet, fromPlain, isPythonInput, pythonCode, parseRef, key, isErr, normKey, formatValue, NUM_FORMATS } from '../engine/index.js';
import { GridView } from './grid.js';
import { PythonRunner } from './python.js';
import { AiPanel } from './ai.js';
import * as store from './store.js';
import { applyActions as applyActionsTo } from './actions.js';

const MAX_UNDO = 100;
const MAX_PY_ROUNDS = 25;

const $ = (sel) => document.querySelector(sel);

/** Engine value -> JSON for Python / snapshots. */
function plain(v) {
  if (v === undefined || v === null) return null;
  if (isErr(v)) return { error: v.code, message: v.message };
  return v;
}

class App {
  state = {
    title: 'Untitled',
    cells: new Map(), // key -> raw input
    formats: new Map(), // key -> {bold, italic, align, numFmt, bg, color}
    colWidths: {},
    rows: 100,
    cols: 26,
    values: new Map(),
    spills: new Map(),
  };

  py = {
    results: new Map(), // key -> engine value
    meta: new Map(), // key -> {code, reads: {ref: json}, stdout, error}
    trusted: true,
    pumping: false,
    again: false,
  };

  undoStack = [];
  redoStack = [];

  constructor() {
    this.grid = new GridView($('#grid'), this);
    this.python = new PythonRunner((s, detail) => this.#setPyStatus(s, detail));
    this.ai = new AiPanel($('#ai-panel'), this);

    const saved = store.loadAutosave();
    if (saved) this.#loadWorkbook(saved, { trusted: true });
    this.#fitDims();
    this.grid.build();
    this.recalc();
    this.#bindChrome();
    if (matchMedia('(max-width: 820px)').matches) document.body.classList.remove('ai-open');
    this.onSelectionChange();
    $('#grid').focus();
  }

  // ---------- queries used by views ----------

  isPythonCell(k) {
    return isPythonInput(this.state.cells.get(k));
  }

  /** Snapshot sent to the AI: inputs plus displayed values. */
  aiSnapshot() {
    const cells = {};
    const keys = [...this.state.cells.keys()].sort(rowMajor);
    for (const k of keys) {
      const v = this.state.values.get(k);
      cells[k] = { input: this.state.cells.get(k), value: formatValue(v, this.state.formats.get(k)?.numFmt) };
    }
    return { title: this.state.title, selection: this.grid.selectionText(), cells };
  }

  // ---------- mutations (all undoable) ----------

  #snapshot() {
    return {
      title: this.state.title,
      cells: new Map(this.state.cells),
      formats: new Map(this.state.formats),
      colWidths: { ...this.state.colWidths },
    };
  }

  #restore(s) {
    Object.assign(this.state, { title: s.title, cells: new Map(s.cells), formats: new Map(s.formats), colWidths: { ...s.colWidths } });
    $('#title').value = this.state.title;
    document.title = `Grids — ${this.state.title}`;
    this.#afterChange({ rebuild: true });
  }

  /** Run fn as one undo step. */
  change(fn, { rebuild = false } = {}) {
    const before = this.#snapshot();
    fn(this.state);
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.#afterChange({ rebuild });
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.#snapshot());
    this.#restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.#snapshot());
    this.#restore(s);
  }

  setInput(k, input) {
    const cur = this.state.cells.get(k) ?? '';
    if (cur === input) return;
    this.change((st) => {
      if (input === '') st.cells.delete(k);
      else st.cells.set(k, input.slice(0, store.MAX_INPUT_CHARS));
    });
  }

  clearSelection() {
    const s = this.grid.selection;
    this.change((st) => {
      for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) st.cells.delete(key(c, r));
    });
  }

  setColumnWidth(col, w) {
    const cw = store.clampWidth(w);
    if (!cw) return;
    this.change((st) => (st.colWidths[col] = cw), { rebuild: true });
  }

  /** Merge a format patch into every selected cell. */
  formatSelection(patch) {
    const s = this.grid.selection;
    this.change((st) => {
      for (let r = s.r1; r <= s.r2; r++)
        for (let c = s.c1; c <= s.c2; c++) {
          const k = key(c, r);
          const f = store.cleanFormat({ ...st.formats.get(k), ...patch });
          if (f) st.formats.set(k, f);
          else st.formats.delete(k);
        }
    });
  }

  /**
   * Apply AI tool calls as ONE undo step. Everything is validated here — the model's
   * output is untrusted input. Returns a list of human-readable problems (skipped calls).
   */
  applyActions(actions) {
    let problems = [];
    this.change((st) => { problems = applyActionsTo(st, actions); }, { rebuild: true });
    $('#title').value = this.state.title;
    document.title = `Grids — ${this.state.title}`;
    return problems;
  }

  #afterChange({ rebuild }) {
    const dimsChanged = this.#fitDims();
    if (rebuild || dimsChanged) this.grid.build();
    this.recalc();
    this.onSelectionChange();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.autosave(this.state), 400);
  }

  /** Grow the grid to fit content (+ a margin). Returns true if it grew. */
  #fitDims() {
    let maxR = 0;
    let maxC = 0;
    for (const k of [...this.state.cells.keys(), ...this.state.spills.keys()]) {
      const r = parseRef(k);
      if (r.row > maxR) maxR = r.row;
      if (r.col > maxC) maxC = r.col;
    }
    const rows = Math.max(this.state.rows, Math.ceil((maxR + 20) / 50) * 50);
    const cols = Math.max(this.state.cols, maxC + 3);
    const changed = rows !== this.state.rows || cols !== this.state.cols;
    this.state.rows = rows;
    this.state.cols = cols;
    return changed;
  }

  // ---------- recalculation + Python ----------

  recalc() {
    const pyKeys = new Set();
    for (const [k, input] of this.state.cells) if (isPythonInput(input)) pyKeys.add(k);
    for (const k of [...this.py.results.keys()]) if (!pyKeys.has(k)) { this.py.results.delete(k); this.py.meta.delete(k); }

    const { values, spills } = evaluateSheet(this.state.cells, { python: this.py.results });
    this.state.values = values;
    this.state.spills = spills;
    if (this.#fitDims()) this.grid.build();
    else this.grid.renderAll();

    $('#py-banner').hidden = this.py.trusted || pyKeys.size === 0;
    if (this.py.trusted && pyKeys.size) this.#pumpPython();
  }

  /** Python cells that never ran, whose code changed, or whose inputs changed since. */
  #stalePython() {
    const stale = [];
    for (const [k, input] of this.state.cells) {
      if (!isPythonInput(input)) continue;
      const meta = this.py.meta.get(k);
      const code = pythonCode(input);
      if (!meta || meta.code !== code) { stale.push(k); continue; }
      for (const [ref, seen] of Object.entries(meta.reads)) {
        if (JSON.stringify(plain(this.state.values.get(ref))) !== JSON.stringify(seen)) { stale.push(k); break; }
      }
    }
    return stale.sort(rowMajor);
  }

  async #pumpPython(force = false) {
    if (this.py.pumping) { this.py.again = true; return; }
    this.py.pumping = true;
    try {
      if (force) this.py.meta.clear();
      for (let round = 0; round < MAX_PY_ROUNDS && this.py.trusted; round++) {
        const k = this.#stalePython()[0];
        if (!k) break;
        const input = this.state.cells.get(k);
        const code = pythonCode(input);
        const values = {};
        for (const [ref, v] of this.state.values) values[ref] = plain(v);
        const res = await this.python.run(code, values);
        if (this.state.cells.get(k) !== input) continue; // edited while running; next round picks it up
        this.py.results.set(k, fromPlain(res.value));
        this.py.meta.set(k, {
          code,
          reads: Object.fromEntries((res.reads ?? []).map((r) => [r, values[r] ?? null])),
          stdout: res.stdout ?? '',
          error: res.error ?? null,
        });
        const { values: vals, spills } = evaluateSheet(this.state.cells, { python: this.py.results });
        this.state.values = vals;
        this.state.spills = spills;
        if (this.#fitDims()) this.grid.build();
        else this.grid.renderAll();
        this.onSelectionChange();
      }
    } finally {
      this.py.pumping = false;
      if (this.py.again) {
        this.py.again = false;
        this.#pumpPython();
      }
    }
  }

  runAllPython() {
    this.py.trusted = true;
    this.recalc();
    this.#pumpPython(true);
  }

  #setPyStatus(status, detail) {
    const el = $('#py-status');
    el.dataset.status = status;
    el.textContent = { loading: 'Python: loading…', running: 'Python: running…', failed: 'Python: failed to load', idle: 'Python: ready' }[status] ?? '';
    el.title = detail ?? '';
  }

  // ---------- selection-dependent chrome ----------

  onSelectionChange() {
    const k = this.grid.activeKey;
    $('#cell-ref').textContent = this.grid.selectionText();
    if (!this.grid.editing) {
      const fx = $('#fx');
      if (document.activeElement !== fx) {
        fx.value = this.state.cells.get(k) ?? '';
        this.#autosizeFx();
      }
    }
    this.#renderStatus();
    this.#syncToolbar();
  }

  onEditorInput(text) {
    const fx = $('#fx');
    fx.value = text;
    this.#autosizeFx();
  }

  #renderStatus() {
    const k = this.grid.activeKey;
    const v = this.state.values.get(k);
    const parts = [];
    if (isErr(v) && v.message) parts.push(`${v.code} ${v.message.split('\n').at(-1)}`);
    const meta = this.py.meta.get(k);
    if (meta?.stdout) parts.push(`stdout: ${meta.stdout.trim().split('\n').slice(-3).join(' ⏎ ')}`);
    if (this.state.spills.has(k)) parts.push(`spilled from ${this.state.spills.get(k)}`);

    const s = this.grid.selection;
    if (s.c1 !== s.c2 || s.r1 !== s.r2) {
      let sum = 0;
      let count = 0;
      for (let r = s.r1; r <= s.r2; r++)
        for (let c = s.c1; c <= s.c2; c++) {
          const x = this.state.values.get(key(c, r));
          if (typeof x === 'number') { sum += x; count++; }
        }
      if (count) parts.push(`Sum ${formatValue(sum)} · Avg ${formatValue(sum / count)} · Count ${count}`);
    }
    $('#status-text').textContent = parts.join('   ·   ');
    $('#status-text').title = isErr(v) ? v.message : meta?.stdout ?? '';
  }

  #syncToolbar() {
    const f = this.state.formats.get(this.grid.activeKey) ?? {};
    $('#btn-bold').setAttribute('aria-pressed', String(!!f.bold));
    $('#btn-italic').setAttribute('aria-pressed', String(!!f.italic));
    for (const a of ['left', 'center', 'right']) $(`#btn-align-${a}`).setAttribute('aria-pressed', String(f.align === a));
    $('#num-format').value = f.numFmt ?? 'general';
  }

  #autosizeFx() {
    const fx = $('#fx');
    fx.style.height = 'auto';
    fx.style.height = `${Math.min(fx.scrollHeight, 200)}px`;
  }

  // ---------- files ----------

  #loadWorkbook(wb, { trusted }) {
    Object.assign(this.state, { title: wb.title, cells: wb.cells, formats: wb.formats, colWidths: wb.colWidths, rows: 100, cols: 26 });
    this.state.spills = new Map();
    this.py.results.clear();
    this.py.meta.clear();
    this.py.trusted = trusted;
    this.undoStack = [];
    this.redoStack = [];
    $('#title').value = this.state.title;
    document.title = `Grids — ${this.state.title}`;
  }

  #replaceWorkbook(wb, opts) {
    this.#loadWorkbook(wb, opts);
    this.#fitDims();
    this.grid.build();
    this.grid.select(0, 0);
    this.recalc();
    store.autosave(this.state);
  }

  newWorkbook() {
    if (this.state.cells.size && !confirm('Start a new workbook? The current one is only kept if you saved it.')) return;
    this.#replaceWorkbook({ title: 'Untitled', cells: new Map(), formats: new Map(), colWidths: {} }, { trusted: true });
  }

  async openFile(file) {
    try {
      const text = await file.text();
      if (/\.csv$/i.test(file.name)) {
        const title = file.name.replace(/\.csv$/i, '');
        this.#replaceWorkbook({ title, cells: store.csvToCells(text), formats: new Map(), colWidths: {} }, { trusted: true });
      } else {
        // Opened files may come from anyone: Python stays off until the user enables it
        this.#replaceWorkbook(store.fromFile(JSON.parse(text)), { trusted: false });
      }
    } catch (e) {
      alert(`Could not open ${file.name}: ${e.message}`);
    }
  }

  saveFile() {
    store.download(`${store.safeFileName(this.state.title)}.grid`, JSON.stringify(store.toFile(this.state), null, 2), 'application/json');
  }

  exportCsv() {
    let maxR = -1;
    let maxC = -1;
    for (const k of this.state.values.keys()) {
      const r = parseRef(k);
      maxR = Math.max(maxR, r.row);
      maxC = Math.max(maxC, r.col);
    }
    const rows = [];
    for (let r = 0; r <= maxR; r++) {
      const row = [];
      for (let c = 0; c <= maxC; c++) row.push(formatValue(this.state.values.get(key(c, r)) ?? null));
      rows.push(row);
    }
    store.download(`${store.safeFileName(this.state.title)}.csv`, store.toCsv(rows), 'text/csv');
  }

  // ---------- clipboard (TSV, like every spreadsheet) ----------

  #copy(e, cut) {
    const s = this.grid.selection;
    const lines = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const row = [];
      for (let c = s.c1; c <= s.c2; c++) row.push(formatValue(this.state.values.get(key(c, r)) ?? null, this.state.formats.get(key(c, r))?.numFmt));
      lines.push(row.join('\t'));
    }
    e.clipboardData.setData('text/plain', lines.join('\n'));
    e.preventDefault();
    if (cut) this.clearSelection();
  }

  #paste(e) {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    const { col, row } = this.grid.anchor;
    this.change((st) => {
      rows.forEach((r, i) =>
        r.forEach((v, j) => {
          const k = key(col + j, row + i);
          if (v === '') st.cells.delete(k);
          else st.cells.set(k, v.slice(0, store.MAX_INPUT_CHARS));
        }),
      );
    });
  }

  // ---------- wiring ----------

  #bindChrome() {
    const gridEl = $('#grid');
    const inGrid = () => document.activeElement === gridEl;

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !inGrid();
      if (mod && !typing && !this.grid.editing) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); return this.undo(); }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); return this.redo(); }
        if (k === 'b') { e.preventDefault(); return $('#btn-bold').click(); }
        if (k === 'i') { e.preventDefault(); return $('#btn-italic').click(); }
        if (k === 's') { e.preventDefault(); return this.saveFile(); }
      }
      if (inGrid() && this.grid.handleKey(e)) e.preventDefault();
    });
    document.addEventListener('copy', (e) => inGrid() && this.#copy(e, false));
    document.addEventListener('cut', (e) => inGrid() && this.#copy(e, true));
    document.addEventListener('paste', (e) => inGrid() && this.#paste(e));

    // Formula bar: Enter commits, Shift+Enter = newline, Escape reverts
    const fx = $('#fx');
    fx.addEventListener('input', () => {
      this.#autosizeFx();
      if (this.grid.editing) this.grid.editor.value = fx.value;
    });
    fx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.setInput(this.grid.activeKey, fx.value);
        gridEl.focus();
        this.grid.select(this.grid.anchor.col, this.grid.anchor.row + 1);
      } else if (e.key === 'Escape') {
        fx.value = this.state.cells.get(this.grid.activeKey) ?? '';
        gridEl.focus();
      }
    });
    fx.addEventListener('focus', () => this.grid.editing && this.grid.cancelEdit());

    $('#title').addEventListener('change', (e) => {
      const t = e.target.value.trim().slice(0, 200) || 'Untitled';
      this.change((st) => (st.title = t));
      document.title = `Grids — ${t}`;
    });

    $('#btn-new').onclick = () => this.newWorkbook();
    $('#btn-open').onclick = () => $('#file-input').click();
    $('#file-input').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.openFile(f);
    };
    $('#btn-save').onclick = () => this.saveFile();
    $('#btn-csv').onclick = () => this.exportCsv();
    $('#btn-undo').onclick = () => this.undo();
    $('#btn-redo').onclick = () => this.redo();
    const toggle = (prop) => () => {
      const f = this.state.formats.get(this.grid.activeKey) ?? {};
      this.formatSelection({ [prop]: !f[prop] });
      gridEl.focus();
    };
    $('#btn-bold').onclick = toggle('bold');
    $('#btn-italic').onclick = toggle('italic');
    for (const a of ['left', 'center', 'right']) {
      $(`#btn-align-${a}`).onclick = () => {
        const f = this.state.formats.get(this.grid.activeKey) ?? {};
        this.formatSelection({ align: f.align === a ? undefined : a });
        gridEl.focus();
      };
    }
    const nf = $('#num-format');
    for (const f of NUM_FORMATS) nf.append(new Option(f === 'general' ? 'General' : f, f));
    nf.onchange = () => {
      this.formatSelection({ numFmt: nf.value });
      gridEl.focus();
    };
    $('#fill-color').oninput = (e) => this.formatSelection({ bg: e.target.value });
    $('#text-color').oninput = (e) => this.formatSelection({ color: e.target.value });
    $('#btn-clear-format').onclick = () => {
      const s = this.grid.selection;
      this.change((st) => {
        for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) st.formats.delete(key(c, r));
      });
      gridEl.focus();
    };
    $('#btn-run-py').onclick = () => this.runAllPython();
    $('#btn-trust').onclick = () => this.runAllPython();
    $('#btn-add-rows').onclick = () => {
      this.state.rows += 100;
      this.grid.build();
    };
    $('#btn-toggle-ai').onclick = () => document.body.classList.toggle('ai-open');
  }
}

function rowMajor(a, b) {
  const ra = parseRef(a);
  const rb = parseRef(b);
  return ra.row - rb.row || ra.col - rb.col;
}

window.grids = new App();
