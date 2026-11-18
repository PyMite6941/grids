# `.grid` file format (v1)

One JSON document per workbook. Both the website (`web/`) and the desktop app
(`desktop/`) read and write exactly this shape, so a file saved by one opens in
the other.

```json
{
  "format": "grids",
  "version": 1,
  "title": "Budget",
  "sheets": [
    {
      "name": "Sheet1",
      "cells":   { "A1": "Rent", "B1": "1200", "B3": "=SUM(B1:B2)", "C1": "=py sum(vals('B1:B2'))" },
      "formats": { "A1": { "bold": true, "align": "center", "numFmt": "0.00", "bg": "#fff2cc", "color": "#1f1f1f", "italic": false } },
      "colWidths": { "A": 140 }
    }
  ]
}
```

## Rules

- **`cells` stores what the user typed, never computed values.** Values are
  recomputed on load. A missing key and `""` both mean "empty".
- Cell keys are A1-style, upper-case, no `$`: `A1` … `ZZZ99999`.
- A cell input is one of:
  | Input | Kind |
  |---|---|
  | starts with `=py ` or `=py` + newline (any case) | **Python cell** – see `shared/python/grid_runtime.py` |
  | starts with `=` | **Formula** – see `FORMULAS.md` |
  | starts with `'` | **Text**, the apostrophe is dropped (`'123` is the text `123`) |
  | number (`42`, `-1.5`, `1e3`, `50%`) | **Number** |
  | `TRUE` / `FALSE` (any case) | **Boolean** |
  | anything else | **Text** |
- `formats` keys and values are all optional. `numFmt` is one of:
  `general`, `0`, `0.00`, `#,##0`, `#,##0.00`, `0%`, `0.00%`, `$#,##0.00`.
  `align` is `left` | `center` | `right`. Colours are `#rrggbb`.
- `colWidths` is in CSS pixels, keyed by column letter.
- Only the first sheet is used by the v0 UIs; the array exists so multi-sheet
  support doesn't need a format bump.

## Trust

Python cells run real code. A file that was **opened from disk** (or received
from someone else) starts *untrusted*: Python cells show `#BUSY!` until the
user explicitly enables Python for that workbook. Trust is UI state and is
**never** stored in the file — otherwise a file could trust itself.
