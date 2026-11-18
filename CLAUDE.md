# CLAUDE.md — Grids

A spreadsheet with an AI built in, plus Python cells. There are two apps: `web/` (Node, zero
deps; it is becoming the main product, a hosted website) and `desktop/` (Java Swing). Read
[README.md](README.md) first.

## Layout

- `shared/` is the single source of truth for both apps:
  - `FORMAT.md`: the `.grid` file format.
  - `FORMULAS.md`: the function list.
  - `KEYS.md`: AI keys, subscriptions and usage.
  - `fixtures/formulas.json`: the formula tests both engines must pass.
  - `ai/`: `tools.json`, the system prompt, and `text-protocol.md` for CLI subscriptions.
  - `python/grid_runtime.py`: the desktop Python worker.
- `web/lib/` holds the server-side modules: `ai.js`, `keyring.js`, `subscriptions.js` and
  `local-guard.js`. `web/public/` is the client; its formula engine is `public/engine/`.
- In `desktop/src/grids/`:
  - `engine/`: the formula engine.
  - `model/`: the workbook.
  - `app/Document.java`: the Swing-free controller.
  - `python/`: the CPython bridge.
  - `ai/`: `AiClient`, `KeyRing`, `Subscriptions`.
  - `ui/`: the Swing UI, including `AppIcon`.

## Rules

- **Parity**: a change to formulas, the file format, AI tools or key-ring rules goes into
  both apps, plus `shared/`. Both engines must pass `shared/fixtures/formulas.json`.
- **Trust**: desktop Python has full machine access, so opened files stay untrusted until
  the user clicks *Enable Python*. AI auto-apply never applies changes that write Python
  cells.
- **Secrets**:
  - Keys live only in the git-ignored `.env`. The UI and the usage file see names, counts
    and the last 4 characters, never a key.
  - On the web server, key editing and subscriptions are allowed only when it is bound to
    loopback (`web/lib/local-guard.js`). Keep that guard tested.
- **Subscriptions**: run the vendor's CLI only, with the prompt on stdin and no tools.
  Never read its login tokens.

## Commands

```bash
cd web && npm test
cd desktop && ./build.sh --smoke    # Windows: .\build.ps1 -Smoke
```

`GRIDS_LIVE_SUB=1` adds one real Claude-subscription call to the desktop smoke test.

## Gotchas

- The repo path contains `ドキュメント`, and javac/java mangle absolute non-ASCII paths.
  `build.ps1` uses relative paths; copy the jar somewhere ASCII when launching it by
  absolute path.
- Write code containing backslash escapes with an editor tool, not shell heredocs or
  `-e` strings. A `\b` once became a literal backspace in a regex and silently broke
  key editing.
- `shared/python/grid_runtime.py` is plumbing written by Claude, not the user's own code.
