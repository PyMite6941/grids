// Grid view: renders the sheet as a <table>, owns selection, the in-cell editor,
// keyboard navigation and column resizing. All data changes go through `app`.
//
// v0 renders every cell (default 100x26). Fine to a few thousand rows; past that
// this needs row virtualisation — the rest of the app doesn't care either way.

import { key, indexToCol, isErr, isArr, formatValue } from '../engine/index.js';

const DEFAULT_WIDTH = 100;

/** Dark or light text for a fill colour, so a light fill stays readable in dark mode. */
function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 140 ? '#1d2127' : '#f5f6f8';
}

export class GridView {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.anchor = { col: 0, row: 0 }; // where the selection started (the active cell)
    this.focus = { col: 0, row: 0 }; // the other corner
    this.editing = null; // {col, row, original}
    this.tds = [];

    this.table = document.createElement('table');
    this.table.className = 'grid';
    this.editor = document.createElement('textarea');
    this.editor.className = 'cell-editor';
    this.editor.spellcheck = false;
    this.editor.setAttribute('aria-label', 'Cell editor');
    this.editor.hidden = true;
    root.append(this.table, this.editor);

    this.#bindMouse();
    this.#bindEditor();
  }

  // ---------- structure ----------

  build() {
    const { rows, cols, colWidths } = this.app.state;
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'corner';
    hr.append(corner);
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.className = 'col-head';
      th.dataset.col = c;
      th.textContent = indexToCol(c);
      th.style.width = th.style.minWidth = th.style.maxWidth = `${colWidths[indexToCol(c)] ?? DEFAULT_WIDTH}px`;
      const grip = document.createElement('div');
      grip.className = 'col-resize';
      grip.dataset.col = c;
      th.append(grip);
      hr.append(th);
    }
    thead.append(hr);

    const tbody = document.createElement('tbody');
    this.tds = [];
    for (let r = 0; r < rows; r++) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.className = 'row-head';
      th.dataset.row = r;
      th.textContent = r + 1;
      tr.append(th);
      const rowTds = [];
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        td.dataset.col = c;
        td.dataset.row = r;
        tr.append(td);
        rowTds.push(td);
      }
      tbody.append(tr);
      this.tds.push(rowTds);
    }
    this.table.replaceChildren(thead, tbody);
    this.renderAll();
  }

  /** Re-render every cell's text + style from app state. */
  renderAll() {
    const { values, formats, spills, cells } = this.app.state;
    for (let r = 0; r < this.tds.length; r++) {
      for (let c = 0; c < this.tds[r].length; c++) {
        const k = key(c, r);
        const td = this.tds[r][c];
        const v = values.get(k) ?? null;
        const f = formats.get(k);
        const text = formatValue(isArr(v) ? null : v, f?.numFmt);
        if (td.textContent !== text) td.textContent = text;
        const cls = ['cell'];
        if (typeof v === 'number') cls.push('num');
        if (typeof v === 'boolean') cls.push('bool');
        if (isErr(v)) cls.push(v.code === '#BUSY!' ? 'busy' : 'err');
        if (spills.has(k)) cls.push('spilled');
        if (this.app.isPythonCell(k)) cls.push('py');
        if (f?.bold) cls.push('b');
        if (f?.italic) cls.push('i');
        const className = cls.join(' ');
        if (td.className !== className) td.className = className;
        td.style.textAlign = f?.align ?? '';
        td.style.background = f?.bg ?? '';
        td.style.color = f?.color ?? (f?.bg ? readableOn(f.bg) : '');
        const title = isErr(v) && v.message ? v.message : cells.has(k) && cells.get(k).length > 30 ? cells.get(k) : '';
        if (td.title !== title) td.title = title;
      }
    }
    this.#paintSelection();
  }

  // ---------- selection ----------

  get selection() {
    return {
      c1: Math.min(this.anchor.col, this.focus.col),
      r1: Math.min(this.anchor.row, this.focus.row),
      c2: Math.max(this.anchor.col, this.focus.col),
      r2: Math.max(this.anchor.row, this.focus.row),
    };
  }

  get activeKey() {
    return key(this.anchor.col, this.anchor.row);
  }

  selectionText() {
    const s = this.selection;
    const a = key(s.c1, s.r1);
    return s.c1 === s.c2 && s.r1 === s.r2 ? a : `${a}:${key(s.c2, s.r2)}`;
  }

  select(col, row, extend = false) {
    const { rows, cols } = this.app.state;
    col = Math.max(0, Math.min(cols - 1, col));
    row = Math.max(0, Math.min(rows - 1, row));
    if (extend) this.focus = { col, row };
    else this.anchor = this.focus = { col, row };
    this.#paintSelection();
    this.#scrollIntoView(extend ? this.focus : this.anchor);
    this.app.onSelectionChange();
  }

  #painted = [];
  #paintSelection() {
    for (const el of this.#painted) el.classList.remove('sel', 'active', 'head-sel');
    this.#painted = [];
    const s = this.selection;
    const mark = (el, cls) => {
      if (!el) return;
      el.classList.add(cls);
      this.#painted.push(el);
    };
    for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) mark(this.tds[r]?.[c], 'sel');
    mark(this.tds[this.anchor.row]?.[this.anchor.col], 'active');
    const heads = this.table.tHead?.rows[0]?.cells;
    for (let c = s.c1; c <= s.c2; c++) mark(heads?.[c + 1], 'head-sel');
    for (let r = s.r1; r <= s.r2; r++) mark(this.table.tBodies[0]?.rows[r]?.cells[0], 'head-sel');
  }

  #scrollIntoView({ col, row }) {
    const td = this.tds[row]?.[col];
    if (!td) return;
    const sc = this.root;
    const headH = this.table.tHead.offsetHeight;
    const headW = this.table.tBodies[0].rows[0].cells[0].offsetWidth;
    if (td.offsetTop - headH < sc.scrollTop) sc.scrollTop = td.offsetTop - headH;
    else if (td.offsetTop + td.offsetHeight > sc.scrollTop + sc.clientHeight) sc.scrollTop = td.offsetTop + td.offsetHeight - sc.clientHeight;
    if (td.offsetLeft - headW < sc.scrollLeft) sc.scrollLeft = td.offsetLeft - headW;
    else if (td.offsetLeft + td.offsetWidth > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = td.offsetLeft + td.offsetWidth - sc.clientWidth;
  }

  // ---------- editing ----------

  startEdit(initial = null) {
    const { col, row } = this.anchor;
    const td = this.tds[row]?.[col];
    if (!td) return;
    const original = this.app.state.cells.get(key(col, row)) ?? '';
    this.editing = { col, row, original };
    const ed = this.editor;
    ed.value = initial ?? original;
    ed.hidden = false;
    ed.style.left = `${td.offsetLeft}px`;
    ed.style.top = `${td.offsetTop}px`;
    ed.style.minWidth = `${td.offsetWidth}px`;
    ed.style.minHeight = `${td.offsetHeight}px`;
    this.#autosize();
    ed.focus();
    ed.setSelectionRange(ed.value.length, ed.value.length);
    this.app.onEditorInput(ed.value);
  }

  /** Commit the editor. move = [dCol, dRow] to step afterwards. */
  commitEdit(move = [0, 1]) {
    if (!this.editing) return;
    const { col, row } = this.editing;
    const value = this.editor.value;
    this.#closeEditor();
    this.app.setInput(key(col, row), value);
    this.select(col + move[0], row + move[1]);
  }

  cancelEdit() {
    if (!this.editing) return;
    this.#closeEditor();
    this.app.onSelectionChange();
  }

  #closeEditor() {
    this.editing = null;
    this.editor.hidden = true;
    this.root.focus({ preventScroll: true });
  }

  #autosize() {
    const ed = this.editor;
    ed.style.height = 'auto';
    ed.style.width = 'auto';
    ed.style.height = `${ed.scrollHeight}px`;
    ed.style.width = `${Math.min(600, Math.max(ed.scrollWidth + 4, parseFloat(ed.style.minWidth)))}px`;
  }

  #bindEditor() {
    const ed = this.editor;
    ed.addEventListener('input', () => {
      this.#autosize();
      this.app.onEditorInput(ed.value);
    });
    ed.addEventListener('keydown', (e) => {
      // The editor handles its own keys; never let them reach the grid's document handler
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.commitEdit([0, 1]);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commitEdit([e.shiftKey ? -1 : 1, 0]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
      }
      // Shift/Alt+Enter falls through: newline (multi-line Python)
    });
    ed.addEventListener('blur', () => {
      // Clicking elsewhere commits, like every spreadsheet
      if (this.editing) this.commitEdit([0, 0]);
    });
  }

  // ---------- mouse ----------

  #bindMouse() {
    let dragging = false;
    this.table.addEventListener('mousedown', (e) => {
      const grip = e.target.closest('.col-resize');
      if (grip) return this.#startResize(e, Number(grip.dataset.col));
      const td = e.target.closest('td');
      const colHead = e.target.closest('th.col-head');
      const rowHead = e.target.closest('th.row-head');
      if (this.editing) this.commitEdit([0, 0]);
      if (td) {
        e.preventDefault();
        this.root.focus({ preventScroll: true });
        this.select(Number(td.dataset.col), Number(td.dataset.row), e.shiftKey);
        dragging = true;
      } else if (colHead) {
        const c = Number(colHead.dataset.col);
        this.anchor = { col: c, row: 0 };
        this.focus = { col: c, row: this.app.state.rows - 1 };
        this.#paintSelection();
        this.app.onSelectionChange();
      } else if (rowHead) {
        const r = Number(rowHead.dataset.row);
        this.anchor = { col: 0, row: r };
        this.focus = { col: this.app.state.cols - 1, row: r };
        this.#paintSelection();
        this.app.onSelectionChange();
      }
    });
    this.table.addEventListener('mouseover', (e) => {
      if (!dragging) return;
      const td = e.target.closest('td');
      if (td) this.select(Number(td.dataset.col), Number(td.dataset.row), true);
    });
    window.addEventListener('mouseup', () => (dragging = false));
    this.table.addEventListener('dblclick', (e) => {
      if (e.target.closest('td')) this.startEdit();
    });
  }

  #startResize(e, col) {
    e.preventDefault();
    const th = this.table.tHead.rows[0].cells[col + 1];
    const startX = e.clientX;
    const startW = th.offsetWidth;
    const move = (ev) => {
      const w = Math.min(600, Math.max(40, startW + ev.clientX - startX));
      th.style.width = th.style.minWidth = th.style.maxWidth = `${w}px`;
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.app.setColumnWidth(indexToCol(col), startW + ev.clientX - startX);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // ---------- keyboard (called by app when the grid has focus) ----------

  handleKey(e) {
    if (this.editing) return false;
    const mod = e.ctrlKey || e.metaKey;
    const { col, row } = e.shiftKey ? this.focus : this.anchor;
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (moves[e.key] && !mod) {
      const [dc, dr] = moves[e.key];
      this.select(col + dc, row + dr, e.shiftKey);
      return true;
    }
    if (e.key === 'Tab') {
      this.select(this.anchor.col + (e.shiftKey ? -1 : 1), this.anchor.row);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      this.startEdit();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.app.clearSelection();
      return true;
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      this.startEdit(e.key);
      return true;
    }
    return false;
  }
}
