// AI side panel. Sends the conversation + a sheet snapshot to /api/ai, shows the
// model's reply and its proposed changes, and applies them through app.applyActions
// as a single undo step.
//
// Proposals are opt-in: the user clicks Apply. "Auto-apply" skips that step, but
// never for changes that write Python cells — those run code, so a human looks first.
//
// Connections (API keys and subscriptions) live in the server's local .env. The
// browser only sees names + usage, picks one (or "auto"), and on a local server can
// add/remove them through /api/ai/keys.

import { isPythonInput } from '../engine/index.js';

const PROVIDER_KEY = 'grids:provider';
const CONNECTION_KEY = 'grids:connection';

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined));
  return n;
}

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

const writesPython = (actions) =>
  actions.some((a) => a.name === 'set_cells' && (a.args.cells ?? []).some((c) => isPythonInput(c?.input)));

function describe(action) {
  const { name, args } = action;
  switch (name) {
    case 'set_cells': {
      const cells = Array.isArray(args.cells) ? args.cells : [];
      const shown = cells.slice(0, 8).map((c) => {
        const input = String(c?.input ?? '');
        return el('li', {}, el('code', {}, String(c?.ref)), ' ← ',
          isPythonInput(input) ? el('span', { class: 'tag py' }, 'Python') : null,
          el('code', {}, input.length > 60 ? `${input.slice(0, 60)}…` : input || '(clear)'));
      });
      if (cells.length > 8) shown.push(el('li', {}, `… and ${cells.length - 8} more`));
      return shown;
    }
    case 'clear_range':
      return [el('li', {}, 'Clear ', el('code', {}, String(args.range)), args.formats ? ' (incl. formatting)' : '')];
    case 'format_range': {
      const { range, ...rest } = args;
      return [el('li', {}, 'Format ', el('code', {}, String(range)), ` — ${Object.entries(rest).map(([k, v]) => `${k}: ${v}`).join(', ')}`)];
    }
    case 'set_column_width':
      return [el('li', {}, `Column ${args.column} width → ${args.width}px`)];
    case 'set_title':
      return [el('li', {}, `Rename workbook to “${args.title}”`)];
    default:
      return [el('li', {}, name)];
  }
}

function summary(actions) {
  return actions
    .map(({ name, args }) =>
      name === 'set_cells' ? `set ${(args.cells ?? []).map((c) => c?.ref).join(', ')}` : `${name} ${args.range ?? args.column ?? args.title ?? ''}`.trim(),
    )
    .join('; ');
}

/** "12 / 100 today" or "12 today", plus a state word when it can't be used. */
function usageText(k) {
  const used = k.limit ? `${k.requests}/${k.limit} today` : `${k.requests} today`;
  if (k.type === 'sub' && k.installed === false) return `${used} · CLI not installed`;
  if (k.coolingFor > 0) return `${used} · paused ${k.coolingFor >= 120 ? `${Math.ceil(k.coolingFor / 60)}m` : `${k.coolingFor}s`}`;
  if (k.limit && k.requests >= k.limit) return `${used} · limit reached`;
  return used;
}

export class AiPanel {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.history = []; // {role, content} sent to the server
    this.busy = false;

    this.connection = el('select', { class: 'ai-connection', 'aria-label': 'AI connection', title: 'Which key or subscription to use' });
    this.connection.addEventListener('change', () => store.set(CONNECTION_KEY, this.connection.value));
    this.log = el('div', { class: 'ai-log', role: 'log', 'aria-live': 'polite' });
    this.input = el('textarea', { class: 'ai-input', rows: '3', placeholder: 'Ask AI to build or change the sheet…  (Enter to send)', 'aria-label': 'Message the AI' });
    this.sendBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Send');
    this.auto = el('input', { type: 'checkbox', id: 'ai-auto' });
    this.dialog = this.#settingsDialog();

    root.append(
      el('header', { class: 'ai-head' },
        el('strong', {}, 'AI'), this.connection,
        el('button', { class: 'icon-btn', type: 'button', title: 'Keys & subscriptions', 'aria-label': 'AI keys and subscriptions', onclick: () => this.#openSettings() }, '⚙')),
      this.log,
      el('form', { class: 'ai-form', onsubmit: (e) => { e.preventDefault(); this.send(); } },
        this.input,
        el('div', { class: 'ai-form-row' },
          el('label', { class: 'ai-auto', for: 'ai-auto' }, this.auto, ' Auto-apply (not Python)'),
          this.sendBtn)),
      this.dialog,
    );
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    this.#note('Ask for anything: “make a monthly budget with totals”, “add a column with each row’s share of the total”, “use Python to fit a trend line to B2:B20”.');
    this.refreshStatus();
  }

  async refreshStatus() {
    try {
      this.status = await (await fetch('/api/ai/status')).json();
    } catch {
      this.status = null;
    }
    this.#renderConnections();
    if (this.dialog.open) this.#renderKeyList();
    if (this.fileWarn) this.#renderFileWarning();
  }

  #renderConnections() {
    const s = this.status;
    const sel = this.connection;
    sel.replaceChildren();
    if (!s) {
      sel.append(el('option', { value: '' }, 'offline'));
      sel.disabled = true;
      return;
    }
    const custom = s.allowCustom ? this.#provider() : null;
    if (custom) {
      sel.append(el('option', { value: 'custom' }, `Custom: ${custom.model || custom.baseUrl}`));
      sel.disabled = true;
      return;
    }
    sel.disabled = !s.keys.length;
    if (!s.keys.length) {
      sel.append(el('option', { value: '' }, 'no AI connected — click ⚙'));
      return;
    }
    const usable = s.keys.filter((k) => k.available).length;
    sel.append(el('option', { value: 'auto' }, `Auto — ${usable} of ${s.keys.length} ready`));
    for (const k of s.keys) {
      const what = k.type === 'sub' ? k.label.replace(/ \(.*\)$/, '') : k.model;
      sel.append(el('option', { value: k.name }, `${k.name} · ${what} · ${usageText(k)}`));
    }
    const want = store.get(CONNECTION_KEY) ?? s.selection ?? 'auto';
    sel.value = [...sel.options].some((o) => o.value === want) ? want : 'auto';
  }

  #provider() {
    try {
      return JSON.parse(store.get(PROVIDER_KEY) ?? 'null');
    } catch {
      return null;
    }
  }

  #note(text, cls = 'note') {
    const n = el('div', { class: `msg ${cls}` }, text);
    this.log.append(n);
    this.log.scrollTop = this.log.scrollHeight;
    return n;
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.#note(text, 'user');
    this.history.push({ role: 'user', content: text });
    this.busy = true;
    this.sendBtn.disabled = true;
    const pending = this.#note('Thinking…', 'assistant pending');
    try {
      const provider = this.status?.allowCustom ? this.#provider() : null;
      const key = provider ? undefined : this.connection.value || 'auto';
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: this.history, sheet: this.app.aiSnapshot(), provider, key }),
      });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      pending.remove();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      this.#renderReply(data);
    } catch (e) {
      pending.remove();
      this.history.pop();
      this.#note(e.message, 'error');
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      this.refreshStatus(); // usage counts changed
    }
  }

  #renderReply({ reply, actions, key, model }) {
    const entry = { role: 'assistant', content: reply };
    this.history.push(entry);
    const msg = this.#note(reply, 'assistant');
    if (key) msg.append(el('div', { class: 'msg-meta' }, `${key} · ${model}`));
    if (!actions?.length) return;

    const status = el('div', { class: 'proposal-status' });
    const applyBtn = el('button', { class: 'btn primary', type: 'button' }, 'Apply');
    const discardBtn = el('button', { class: 'btn', type: 'button' }, 'Discard');
    const box = el('div', { class: 'proposal' },
      el('ul', {}, ...actions.flatMap(describe)),
      el('div', { class: 'proposal-row' }, applyBtn, discardBtn),
      status);
    msg.append(box);

    const finish = (applied) => {
      applyBtn.remove();
      discardBtn.remove();
      entry.content = `${reply}\n[Proposed changes: ${summary(actions)} — ${applied ? 'applied' : 'discarded by the user'}]`;
    };
    applyBtn.onclick = () => {
      const problems = this.app.applyActions(actions);
      finish(true);
      status.textContent = problems.length ? `Applied, but skipped: ${problems.join('; ')}` : 'Applied — Ctrl+Z to undo.';
    };
    discardBtn.onclick = () => {
      finish(false);
      status.textContent = 'Discarded.';
    };
    if (this.auto.checked && !writesPython(actions)) applyBtn.click();
    else if (this.auto.checked) status.textContent = 'Contains Python — review before applying.';
    this.log.scrollTop = this.log.scrollHeight;
  }

  // ---------- settings: keys & subscriptions ----------

  #settingsDialog() {
    this.keyList = el('div', { class: 'key-list' });
    this.keyMsg = el('p', { class: 'key-msg', role: 'status' });
    this.editNote = el('p', { class: 'muted' });

    const f = (this.keyFields = {
      name: el('input', { type: 'text', placeholder: 'GROQ1', maxlength: '32', autocomplete: 'off', required: '' }),
      apiKey: el('input', { type: 'password', placeholder: 'gsk_… / sk-or-… / sk-…', autocomplete: 'off', required: '' }),
      limit: el('input', { type: 'number', min: '1', placeholder: 'e.g. 1000 (optional)' }),
      baseUrl: el('input', { type: 'url', placeholder: 'default: server AI_BASE_URL (Groq)' }),
      model: el('input', { type: 'text', placeholder: 'default: server AI_MODEL' }),
    });
    this.keyHead = el('h3', {}, 'Add an API key');
    this.keySubmit = el('button', { class: 'btn primary', type: 'submit' }, 'Add key');
    this.addKeyForm = el('form', { class: 'key-form', onsubmit: (e) => { e.preventDefault(); this.#submitForm('key'); } },
      this.keyHead,
      el('p', { class: 'muted' }, 'Any OpenAI-compatible provider: Groq, OpenRouter, OpenAI, Gemini, Together, DeepSeek… Saved to the .env on this computer only.'),
      el('div', { class: 'grid2' },
        el('label', {}, 'Name', f.name),
        el('label', {}, 'Daily request limit', f.limit)),
      el('label', {}, 'API key', f.apiKey),
      el('div', { class: 'grid2' },
        el('label', {}, 'Base URL', f.baseUrl),
        el('label', {}, 'Model', f.model)),
      el('div', { class: 'dialog-row' }, this.#cancelButton(), this.keySubmit));

    const s = (this.subFields = {
      kind: el('select', {}),
      name: el('input', { type: 'text', placeholder: 'CLAUDE', maxlength: '32', autocomplete: 'off', required: '' }),
      limit: el('input', { type: 'number', min: '1', placeholder: 'optional' }),
      model: el('input', { type: 'text', placeholder: 'CLI default (e.g. sonnet, haiku, gpt-5, gemini-2.5-pro)' }),
    });
    this.subHint = el('p', { class: 'muted' });
    s.kind.addEventListener('change', () => this.#updateSubHint());
    this.subHead = el('h3', {}, 'Add a subscription');
    this.subSubmit = el('button', { class: 'btn primary', type: 'submit' }, 'Add subscription');
    this.addSubForm = el('form', { class: 'key-form', onsubmit: (e) => { e.preventDefault(); this.#submitForm('sub'); } },
      this.subHead,
      el('p', { class: 'muted' }, 'Use a plan you already pay for. Grids runs the vendor’s own CLI on this computer, signed in with your account. No key is stored.'),
      el('label', {}, 'Subscription', s.kind),
      this.subHint,
      el('div', { class: 'grid2' },
        el('label', {}, 'Name', s.name),
        el('label', {}, 'Daily request limit', s.limit)),
      el('label', {}, 'Model', s.model),
      el('div', { class: 'dialog-row' }, this.#cancelButton(), this.subSubmit));

    // Advanced: browser-supplied provider, only when the server allows it
    this.fields = {
      baseUrl: el('input', { type: 'url', placeholder: 'https://api.groq.com/openai/v1  or  http://localhost:11434/v1' }),
      model: el('input', { type: 'text', placeholder: 'openai/gpt-oss-120b, llama3.1, …' }),
      apiKey: el('input', { type: 'password', placeholder: 'leave empty for Ollama / local', autocomplete: 'off' }),
    };
    this.customBox = el('details', { class: 'custom-provider' },
      el('summary', {}, 'Advanced: provider stored in this browser'),
      el('p', { class: 'muted' }, 'Overrides the connections above for this browser only; sent to this server with each request.'),
      el('label', {}, 'Base URL', this.fields.baseUrl),
      el('label', {}, 'Model', this.fields.model),
      el('label', {}, 'API key', this.fields.apiKey),
      el('div', { class: 'dialog-row' },
        el('button', { class: 'btn', type: 'button', onclick: () => this.#saveProvider(null) }, 'Clear'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => this.#saveProvider(this.#readFields()) }, 'Use this provider')));

    return el('dialog', { class: 'settings wide' },
      el('div', { class: 'dialog-head' },
        el('h2', {}, 'AI keys & subscriptions'),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => this.dialog.close() }, '✕')),
      el('p', { class: 'muted' }, 'Pick one in the panel, or choose Auto: it uses whichever has the most of its daily limit left and switches when one is rate-limited or used up.'),
      this.fileWarn = el('p', { class: 'key-error', hidden: '' }),
      this.keyList,
      this.keyMsg,
      this.editNote,
      this.addSubForm,
      this.addKeyForm,
      this.customBox);
  }

  #values(fields) {
    return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value.trim()]));
  }

  #cancelButton() {
    const b = el('button', { class: 'btn', type: 'button', hidden: '', onclick: () => this.#endEdit() }, 'Cancel');
    (this.cancelButtons ??= []).push(b);
    return b;
  }

  /** Submit the key or subscription form: add, or update the connection being edited. */
  #submitForm(type) {
    const fields = type === 'sub' ? this.subFields : this.keyFields;
    const values = this.#values(fields);
    const editing = this.editing?.type === type ? this.editing.name : null;
    const action = editing ? (type === 'sub' ? 'update-sub' : 'update') : type === 'sub' ? 'add-sub' : 'add';
    this.#editKeys({ action, ...values, ...(editing ? { name: editing } : {}) }, fields);
  }

  /** Load a connection into its form for editing. The API key itself is never sent back to the page. */
  #startEdit(k) {
    this.#endEdit();
    this.editing = { type: k.type, name: k.name };
    const c = k.config ?? {};
    if (k.type === 'sub') {
      const s = this.subFields;
      s.kind.value = k.kind;
      s.name.value = k.name;
      s.name.disabled = true;
      s.limit.value = c.limit;
      s.model.value = c.model;
      this.subHead.textContent = `Edit subscription ${k.name}`;
      this.subSubmit.textContent = 'Save changes';
      this.#updateSubHint();
      this.addSubForm.scrollIntoView({ block: 'nearest' });
      s.limit.focus();
    } else {
      const f = this.keyFields;
      f.name.value = k.name;
      f.name.disabled = true;
      f.apiKey.value = '';
      f.apiKey.required = false;
      f.apiKey.placeholder = `leave blank to keep the current key (${k.hint})`;
      f.limit.value = c.limit;
      f.baseUrl.value = c.baseUrl;
      f.model.value = c.model;
      this.keyHead.textContent = `Edit API key ${k.name}`;
      this.keySubmit.textContent = 'Save changes';
      this.addKeyForm.scrollIntoView({ block: 'nearest' });
      f.limit.focus();
    }
    for (const b of this.cancelButtons) b.hidden = false;
  }

  #endEdit() {
    this.editing = null;
    for (const f of [...Object.values(this.keyFields), ...Object.values(this.subFields)]) {
      if (f.tagName !== 'SELECT') f.value = '';
      f.disabled = false;
    }
    this.keyFields.apiKey.required = true;
    this.keyFields.apiKey.placeholder = 'gsk_… / sk-or-… / sk-…';
    this.keyHead.textContent = 'Add an API key';
    this.keySubmit.textContent = 'Add key';
    this.subHead.textContent = 'Add a subscription';
    this.subSubmit.textContent = 'Add subscription';
    for (const b of this.cancelButtons ?? []) b.hidden = true;
  }

  #updateSubHint() {
    const t = (this.status?.subscriptionTypes ?? []).find((x) => x.kind === this.subFields.kind.value);
    this.subHint.textContent = t ? (t.installed ? `CLI found. ${t.login}` : `CLI not found on this computer. Install it, then: ${t.login}`) : '';
    if (!this.subFields.name.value && t) this.subFields.name.placeholder = t.kind.toUpperCase();
  }

  #renderKeyList() {
    const s = this.status;
    this.keyList.replaceChildren();
    if (!s) return this.keyList.append(el('p', { class: 'muted' }, 'Server offline.'));
    if (!s.keys.length) this.keyList.append(el('p', { class: 'muted' }, 'Nothing connected yet — add a subscription or an API key below.'));
    for (const k of s.keys) {
      const bad = !k.available;
      this.keyList.append(el('div', { class: `key-row${bad ? ' unavailable' : ''}` },
        el('div', { class: 'key-main' },
          el('strong', {}, k.name), ' ',
          el('span', { class: `tag ${k.type}` }, k.type === 'sub' ? 'subscription' : 'API key'),
          el('div', { class: 'muted' }, `${k.type === 'sub' ? k.label : k.host} · ${k.model}${k.type === 'key' ? ` · ${k.hint}` : ''}`),
          el('div', { class: 'key-usage' }, `${usageText(k)} · ${k.tokens.toLocaleString()} tokens${k.rateLimited ? ` · ${k.rateLimited}× rate-limited` : ''}`),
          k.lastError ? el('div', { class: 'key-error' }, k.lastError) : null),
        s.canEditKeys && k.name !== 'LOCAL'
          ? el('div', { class: 'key-actions' },
              k.editable ? el('button', { class: 'btn', type: 'button', onclick: () => this.#startEdit(k) }, 'Edit') : null,
              el('button', { class: 'btn', type: 'button', onclick: () => this.#confirmRemove(k) }, 'Remove'))
          : null));
    }
  }

  #confirmRemove(k) {
    const what = k.type === 'sub' ? 'subscription' : 'API key';
    const extra = k.type === 'sub' ? ' Your plan and CLI sign-in are not affected.' : ' The key is deleted from the .env file; keep a copy if you need it.';
    if (!window.confirm(`Remove the ${what} ${k.name}?${extra}`)) return;
    if (this.editing?.name === k.name) this.#endEdit();
    this.#editKeys({ action: 'remove', name: k.name });
  }

  #renderFileWarning() {
    const f = this.status?.keyFile;
    this.fileWarn.hidden = !f?.synced;
    if (f?.synced) {
      this.fileWarn.textContent = f.path
        ? `Your key file (${f.path}) is in a cloud-synced folder, so your keys are uploaded with it. Run "npm run setup" in web/ to move it to ${f.homePath}.`
        : 'This server keeps its key file in a cloud-synced folder.';
    }
  }

  async #editKeys(body, clearFields) {
    this.keyMsg.textContent = 'Saving…';
    this.keyMsg.className = 'key-msg';
    try {
      const res = await fetch('/api/ai/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      this.keyMsg.textContent = body.action === 'remove' ? `Removed ${body.name}.` : body.action.startsWith('update') ? `Updated ${body.name}.` : `Added ${String(body.name).toUpperCase()}.`;
      const was = this.editing;
      if (was) this.#endEdit();
      else if (clearFields) for (const f of Object.values(clearFields)) if (f.tagName !== 'SELECT') f.value = '';
      if (body.action === 'add' || body.action === 'add-sub') store.set(CONNECTION_KEY, null); // let the new one be reachable via Auto/default
      await this.refreshStatus();
    } catch (e) {
      this.keyMsg.textContent = e.message;
      this.keyMsg.className = 'key-msg error';
    }
  }

  #readFields() {
    const p = Object.fromEntries(Object.entries(this.fields).map(([k, f]) => [k, f.value.trim()]));
    return p.baseUrl || p.model || p.apiKey ? p : null;
  }

  #saveProvider(p) {
    store.set(PROVIDER_KEY, p ? JSON.stringify(p) : null);
    this.refreshStatus();
  }

  async #openSettings() {
    await this.refreshStatus();
    const s = this.status ?? {};
    const types = s.subscriptionTypes ?? [];
    this.subFields.kind.replaceChildren(...types.map((t) => el('option', { value: t.kind }, `${t.label}${t.installed ? '' : ' — not installed'}`)));
    this.#updateSubHint();
    this.addSubForm.hidden = !s.canEditKeys || !s.allowSubscriptions;
    this.addKeyForm.hidden = !s.canEditKeys;
    this.editNote.textContent = s.canEditKeys
      ? (s.allowSubscriptions ? '' : 'Subscriptions are off: this server is reachable by others (ALLOW_SUBSCRIPTIONS=1 overrides).')
      : 'This server is not running on your computer, so keys can only be changed in its .env file (see shared/KEYS.md).';
    this.customBox.hidden = !s.allowCustom;
    const p = this.#provider() ?? {};
    for (const [k, f] of Object.entries(this.fields)) f.value = p[k] ?? '';
    this.keyMsg.textContent = '';
    this.#endEdit();
    this.#renderKeyList();
    this.dialog.showModal();
  }
}
