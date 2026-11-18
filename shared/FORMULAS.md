# Formula language (v0)

There are two engines — JavaScript (`web/public/engine/`) and Java
(`desktop/src/grids/engine/`). They must agree. `fixtures/formulas.json` is the
contract: both test suites run every case in it. **Change behaviour by adding a
fixture first**, then make both engines pass.

## Values

| Type | Notes |
|---|---|
| number | IEEE double. `NaN`/`Infinity` never escape — they become `#NUM!` |
| text | |
| boolean | `TRUE` / `FALSE` |
| empty | a cell with no input. `0` in maths, `""` in text |
| error | `#DIV/0!` `#VALUE!` `#REF!` `#NAME?` `#NUM!` `#CIRC!` `#SPILL!` `#ERROR!` (parse error) `#BUSY!` (Python not run yet) `#PYTHON!` (Python raised) |
| array | 2-D, produced by ranges and array functions; **spills** into the cells below/right |

## Syntax

Precedence, loosest first:

1. comparison `=  <>  <  >  <=  >=`
2. concatenation `&`
3. `+  -`
4. `*  /`
5. `^` (left-associative, like Excel: `2^3^2` = 64)
6. unary `-  +` (binds tighter than `^`: `-2^2` = 4)
7. postfix `%`

Operands: numbers (`1`, `.5`, `1e3`), strings (`"a ""quoted"" b"`), `TRUE`,
`FALSE`, references (`A1`, `$B$2`), ranges (`A1:C3`), function calls
(case-insensitive), parentheses.

## Coercion

- Maths: empty → 0, `TRUE` → 1, numeric text (`"5"`) → 5, other text → `#VALUE!`.
- Text: numbers print in shortest form (`3`, not `3.0`), booleans as `TRUE`/`FALSE`.
- Comparison: text compares case-insensitively. Mixed types order
  number < text < boolean. Empty adopts the other side's type.
- Errors propagate through everything except `IFERROR`.
- References and ranges passed to functions are arrays, so aggregates
  (`SUM` etc.) **skip** text/booleans/empties found in ranges, but coerce
  literal arguments (`SUM("2", TRUE)` = 3).
- An array in a scalar spot (`=A1:A3+1`) is `#VALUE!` (no array maths yet).

## Spilling

A formula (or Python cell) that returns an array shows its top-left value and
spills the rest right/down. If any target cell has input, or another spill
already claimed it, the anchor shows `#SPILL!` and nothing spills. Other cells
can reference spilled cells normally.

## Functions

`SUM AVERAGE MIN MAX COUNT COUNTA` · `IF IFERROR AND OR NOT` ·
`ROUND ABS SQRT POWER MOD` · `CONCAT LEN UPPER LOWER TRIM LEFT RIGHT` ·
array: `SEQUENCE(rows,[cols],[start],[step]) TRANSPOSE(range) SORT(range,[col],[ascending])`

Unknown names → `#NAME?`. Wrong argument count → `#VALUE!`.

`ROUND` rounds half away from zero on the *shortest decimal form* of the
number, so `ROUND(2.345, 2)` = 2.35 (naive float maths gives 2.34).

## Not yet

Cross-sheet refs, whole-column refs (`A:A`), array arithmetic, `SUMIF`/`COUNTIF`
/`VLOOKUP`/`XLOOKUP`, dates. Add fixtures, then implement in both engines.
