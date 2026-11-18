# Grids

A spreadsheet with an AI built in. Bring your own key or subscription, and type Python
into cells next to normal formulas.

- **Formulas**: `=SUM(B2:B9)`, `IF`, `VLOOKUP`, `SORT`, `SEQUENCE`, with spilling
  arrays. The function list is in [shared/FORMULAS.md](shared/FORMULAS.md).
- **Python cells**: start a cell with `=py `, e.g. `=py sum(vals('B1:B9'))`. A cell can
  hold a whole script, and its last value can be a number, a list or a table. The result
  spills like a formula. Formulas can read Python results and Python
  can read cells, and a cell reruns when anything it read changes.
- **AI**: ask it to build or change the sheet. It proposes changes and you Apply or
  Discard them, as one undo step. It works with any OpenAI-compatible provider (Groq,
  OpenRouter, OpenAI, Gemini, Ollama…) or a plan you already pay for (Claude Pro/Max,
  ChatGPT Plus/Pro, Google AI) through that vendor's CLI.
- **Keys**: several keys and subscriptions live in one local `.env`. Usage is tracked per
  day, and **Auto** switches to whichever connection has headroom. See
  [shared/KEYS.md](shared/KEYS.md).

Two apps share one file format ([shared/FORMAT.md](shared/FORMAT.md)) and one formula test
suite:

| | Stack | Python runs in |
|---|---|---|
| `web/` | Node ≥ 22, no dependencies | the browser (Pyodide), sandboxed |
| `desktop/` | Java 21+, Swing, no build tool | local CPython, with full access, so it is **off for files you open** until you click *Enable Python* |

## Run

```bash
# website: http://127.0.0.1:5173
cd web && npm start

# desktop (Windows: .\build.ps1 -Run)
cd desktop && ./build.sh --run
```

Connect an AI from the app (**AI → ⚙ / Keys**), or copy `.env.example` to `.env`.

## Test

```bash
cd web && npm test                        # engine, server, key ring, guards
cd desktop && ./build.sh --smoke          # formula fixtures + desktop smoke (needs Python)
```
