"""Runtime for "=py" cells, shared by both front ends.

- Website: loaded into Pyodide inside a Web Worker (web/public/js/python-worker.js)
  and called through run_cell_json().
- Desktop: started as `python -I -u grid_runtime.py` by PythonBridge.java and
  driven over stdin/stdout, one JSON object per line (see serve()).

A cell's code runs in a fresh namespace with these helpers:
    cell("A1")          -> value of one cell
    rng("A1:C3")        -> 2-D list (rows), empties are None
    vals("A1:A10")      -> flat list of the non-empty values
    df("A1:C10")        -> pandas DataFrame, first row is the header
The last expression is the cell's value. Lists / lists of lists / DataFrames
spill into neighbouring cells, like array formulas.

Stdlib only (pandas is optional and only imported by df()).
"""

import ast
import contextlib
import io
import json
import linecache
import math
import re
import sys
import textwrap
import traceback

MAX_CELLS = 250_000
_REF = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$")


class GridError(Exception):
    """A spreadsheet error value (#DIV/0! etc.) seen from Python."""

    def __init__(self, code, message=""):
        super().__init__(code)
        self.code = code
        self.message = message

    def __repr__(self):
        return self.code

    __str__ = __repr__


def _col_index(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _col_name(i):
    s = ""
    n = i + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _parse_ref(text):
    m = _REF.match(str(text).strip())
    if not m:
        raise ValueError(f"not a cell reference: {text!r}")
    return _col_index(m.group(1)), int(m.group(2)) - 1


def _parse_range(text):
    parts = str(text).split(":")
    if len(parts) > 2:
        raise ValueError(f"not a range: {text!r}")
    c1, r1 = _parse_ref(parts[0])
    c2, r2 = _parse_ref(parts[-1])
    c1, c2 = sorted((c1, c2))
    r1, r2 = sorted((r1, r2))
    if (c2 - c1 + 1) * (r2 - r1 + 1) > MAX_CELLS:
        raise ValueError("range too large")
    return c1, r1, c2, r2


def _from_json(v):
    if isinstance(v, dict) and "error" in v:
        return GridError(v["error"], v.get("message", ""))
    return v


class _Sheet:
    """Read access to the evaluated sheet. Records which cells were read so the
    host only re-runs this cell when one of them changes."""

    def __init__(self, values):
        self.values = values
        self.reads = set()

    def cell(self, ref):
        c, r = _parse_ref(ref)
        k = _col_name(c) + str(r + 1)
        self.reads.add(k)
        return _from_json(self.values.get(k))

    def rng(self, text):
        c1, r1, c2, r2 = _parse_range(text)
        return [[self.cell(_col_name(c) + str(r + 1)) for c in range(c1, c2 + 1)] for r in range(r1, r2 + 1)]

    def vals(self, text):
        return [v for row in self.rng(text) for v in row if v is not None]

    def df(self, text, header=True):
        import pandas as pd

        rows = self.rng(text)
        if header and rows:
            return pd.DataFrame(rows[1:], columns=[str(h) for h in rows[0]])
        return pd.DataFrame(rows)


def _scalar(v):
    """Python value -> JSON-safe scalar."""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, GridError):
        return {"error": v.code, "message": v.message}
    if isinstance(v, (int, float)):
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return {"error": "#NUM!", "message": "NaN or infinity"}
        return int(v) if isinstance(v, int) and abs(v) < 2**53 else f
    if hasattr(v, "item") and callable(v.item):  # numpy scalar
        try:
            return _scalar(v.item())
        except Exception:
            pass
    if hasattr(v, "isoformat"):  # date / datetime
        return v.isoformat()
    return str(v)


def to_cell_value(v):
    """Python result -> scalar or 2-D list (spill)."""
    if hasattr(v, "columns") and hasattr(v, "values") and hasattr(v, "to_dict"):  # DataFrame
        rows = [[str(c) for c in v.columns]] + [list(r) for r in v.values.tolist()]
        return _grid(rows)
    if hasattr(v, "tolist") and not isinstance(v, (str, bytes)):  # numpy array / Series
        v = v.tolist()
    if isinstance(v, dict):
        return _grid([[k, x] for k, x in v.items()])
    if isinstance(v, (list, tuple, set, range)):
        v = list(v)
        if not v:
            return None
        if all(isinstance(x, (list, tuple)) for x in v):
            return _grid([list(x) for x in v])
        return _grid([[x] for x in v])  # flat list -> one column
    return _scalar(v)


def _grid(rows):
    if sum(len(r) for r in rows) > MAX_CELLS:
        return {"error": "#NUM!", "message": f"result has more than {MAX_CELLS} cells"}
    return [[_scalar(x) for x in r] for r in rows]


def run_cell(code, values):
    """Run one cell. values = {"A1": json value}. Returns a JSON-safe dict:
    {"value": ..., "stdout": str, "reads": [refs], "error": str|None}"""
    sheet = _Sheet(values)
    ns = {
        "__name__": "__grid__",
        "cell": sheet.cell,
        "rng": sheet.rng,
        "vals": sheet.vals,
        "df": sheet.df,
        "GridError": GridError,
    }
    out = io.StringIO()
    src = textwrap.dedent(code.lstrip("\r\n").rstrip())
    # Lets tracebacks show the offending line of the cell
    linecache.cache["<cell>"] = (len(src), None, src.splitlines(True), "<cell>")
    real_stdin = sys.stdin
    sys.stdin = io.StringIO()  # input() must never eat the desktop protocol stream
    try:
        tree = ast.parse(src, "<cell>", "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        with contextlib.redirect_stdout(out):
            exec(compile(tree, "<cell>", "exec"), ns)
            result = eval(compile(last, "<cell>", "eval"), ns) if last else None
        value = to_cell_value(result)
        return {"value": value, "stdout": out.getvalue(), "reads": sorted(sheet.reads), "error": None}
    except Exception as e:
        # Only show frames from the user's code, not from this runtime
        te = traceback.TracebackException.from_exception(e)
        te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename == "<cell>"])
        msg = "".join(te.format()).strip()
        return {
            "value": {"error": "#PYTHON!", "message": msg},
            "stdout": out.getvalue(),
            "reads": sorted(sheet.reads),
            "error": msg,
        }
    finally:
        sys.stdin = real_stdin


def run_cell_json(request_json):
    """Pyodide entry point: JSON string in, JSON string out."""
    req = json.loads(request_json)
    return json.dumps(run_cell(req["code"], req.get("values", {})))


def serve():
    """Desktop entry point: newline-delimited JSON over stdin/stdout.
    Request  {"id": n, "code": "...", "values": {...}}
    Response {"id": n, "value": ..., "stdout": "...", "reads": [...], "error": ...}"""
    proto = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            res = run_cell(req["code"], req.get("values", {}))
            res["id"] = req.get("id")
        except Exception as e:
            res = {"id": None, "value": {"error": "#PYTHON!", "message": str(e)}, "stdout": "", "reads": [], "error": str(e)}
        proto.write(json.dumps(res) + "\n")
        proto.flush()


if __name__ == "__main__":
    serve()
