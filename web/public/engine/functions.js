// Built-in functions. Each receives already-evaluated arguments: scalars, GridErrors,
// or 2-D arrays (every reference/range argument arrives as an array, so aggregates can
// tell "text found in a range" (skipped) from "text passed literally" (coerced)).
// Keep this list in step with desktop/src/grids/engine/Functions.java and FORMULAS.md.

import { err, isErr, isArr, num, toNumber, toBool, toText, compare, scalar } from './values.js';

const MAX_ARRAY_CELLS = 250_000;

function arity(args, min, max = min) {
  return args.length >= min && args.length <= max;
}

/** Scalar argument coerced to number (errors pass through). */
function n(v) {
  return toNumber(scalar(v));
}

/** Collect numbers for SUM/AVERAGE/MIN/MAX. Returns {nums} or {error}. */
function collectNumbers(args) {
  const nums = [];
  for (const a of args) {
    if (isArr(a)) {
      for (const row of a)
        for (const v of row) {
          if (isErr(v)) return { error: v };
          if (typeof v === 'number') nums.push(v);
        }
    } else {
      if (a === null) continue;
      const x = toNumber(a);
      if (isErr(x)) return { error: x };
      nums.push(x);
    }
  }
  return { nums };
}

function aggregate(fn) {
  return (args) => {
    if (args.length === 0) return err('#VALUE!');
    const { nums, error } = collectNumbers(args);
    return error ?? fn(nums);
  };
}

function* flat(args) {
  for (const a of args) {
    if (isArr(a)) for (const row of a) yield* row;
    else yield a;
  }
}

function logical(args, combine) {
  if (args.length === 0) return err('#VALUE!');
  let acc = null;
  for (const a of args) {
    const items = isArr(a) ? a.flat().filter((v) => typeof v === 'boolean' || typeof v === 'number' || isErr(v)) : [a];
    for (const v of items) {
      const b = toBool(v);
      if (isErr(b)) return b;
      acc = acc === null ? b : combine(acc, b);
    }
  }
  return acc === null ? err('#VALUE!') : acc;
}

/** Round half away from zero, on the shortest decimal form of x (so 2.345 -> 2.35). */
export function roundHalfAway(x, digits) {
  const s = Math.abs(x).toString();
  let r;
  if (s.includes('e')) {
    const p = 10 ** digits;
    r = Math.round(Math.abs(x) * p) / p;
  } else {
    r = Number(Math.round(Number(`${s}e${digits}`)) + `e${-digits}`);
  }
  return Math.sign(x) * r || 0;
}

function textFn(fn) {
  return (args) => {
    if (!arity(args, 1)) return err('#VALUE!');
    const s = toText(scalar(args[0]));
    return isErr(s) ? s : fn(s);
  };
}

function leftRight(take) {
  return (args) => {
    if (!arity(args, 1, 2)) return err('#VALUE!');
    const s = toText(scalar(args[0]));
    if (isErr(s)) return s;
    const k = args.length > 1 ? n(args[1]) : 1;
    if (isErr(k)) return k;
    if (k < 0) return err('#VALUE!');
    return take(s, Math.floor(k));
  };
}

/** Coerce an argument to a 2-D array. */
function grid(v) {
  return isArr(v) ? v : [[v]];
}

export const FUNCTIONS = {
  SUM: aggregate((xs) => num(xs.reduce((s, x) => s + x, 0))),
  AVERAGE: aggregate((xs) => (xs.length ? num(xs.reduce((s, x) => s + x, 0) / xs.length) : err('#DIV/0!'))),
  MIN: aggregate((xs) => (xs.length ? xs.reduce((m, x) => (x < m ? x : m)) : 0)),
  MAX: aggregate((xs) => (xs.length ? xs.reduce((m, x) => (x > m ? x : m)) : 0)),
  COUNT: (args) => {
    let c = 0;
    for (const v of flat(args)) if (typeof v === 'number') c++;
    return c;
  },
  COUNTA: (args) => {
    let c = 0;
    for (const v of flat(args)) if (v !== null) c++;
    return c;
  },

  IF: (args) => {
    if (!arity(args, 2, 3)) return err('#VALUE!');
    const c = toBool(scalar(args[0]));
    if (isErr(c)) return c;
    return c ? args[1] : args.length > 2 ? args[2] : false;
  },
  IFERROR: (args) => {
    if (!arity(args, 2)) return err('#VALUE!');
    return isErr(args[0]) ? args[1] : args[0];
  },
  AND: (args) => logical(args, (a, b) => a && b),
  OR: (args) => logical(args, (a, b) => a || b),
  NOT: (args) => {
    if (!arity(args, 1)) return err('#VALUE!');
    const b = toBool(scalar(args[0]));
    return isErr(b) ? b : !b;
  },

  ROUND: (args) => {
    if (!arity(args, 1, 2)) return err('#VALUE!');
    const x = n(args[0]);
    if (isErr(x)) return x;
    const d = args.length > 1 ? n(args[1]) : 0;
    if (isErr(d)) return d;
    return num(roundHalfAway(x, Math.trunc(d)));
  },
  ABS: (args) => {
    if (!arity(args, 1)) return err('#VALUE!');
    const x = n(args[0]);
    return isErr(x) ? x : Math.abs(x);
  },
  SQRT: (args) => {
    if (!arity(args, 1)) return err('#VALUE!');
    const x = n(args[0]);
    if (isErr(x)) return x;
    return x < 0 ? err('#NUM!') : Math.sqrt(x);
  },
  POWER: (args) => {
    if (!arity(args, 2)) return err('#VALUE!');
    const a = n(args[0]);
    if (isErr(a)) return a;
    const b = n(args[1]);
    if (isErr(b)) return b;
    return num(Math.pow(a, b));
  },
  MOD: (args) => {
    if (!arity(args, 2)) return err('#VALUE!');
    const a = n(args[0]);
    if (isErr(a)) return a;
    const b = n(args[1]);
    if (isErr(b)) return b;
    if (b === 0) return err('#DIV/0!');
    return num(a - b * Math.floor(a / b));
  },

  CONCAT: (args) => {
    if (args.length === 0) return err('#VALUE!');
    let s = '';
    for (const v of flat(args)) {
      const t = toText(v);
      if (isErr(t)) return t;
      s += t;
    }
    return s;
  },
  LEN: textFn((s) => s.length),
  UPPER: textFn((s) => s.toUpperCase()),
  LOWER: textFn((s) => s.toLowerCase()),
  // Excel TRIM only touches the space character, not tabs/newlines
  TRIM: textFn((s) => s.replace(/^ +| +$/g, '').replace(/ +/g, ' ')),
  LEFT: leftRight((s, k) => s.slice(0, k)),
  RIGHT: leftRight((s, k) => (k === 0 ? '' : s.slice(-k))),

  SEQUENCE: (args) => {
    if (!arity(args, 1, 4)) return err('#VALUE!');
    const [rows, cols, start, step] = [args[0], args[1] ?? 1, args[2] ?? 1, args[3] ?? 1].map(n);
    for (const x of [rows, cols, start, step]) if (isErr(x)) return x;
    const r = Math.trunc(rows);
    const c = Math.trunc(cols);
    if (r < 1 || c < 1) return err('#VALUE!');
    if (r * c > MAX_ARRAY_CELLS) return err('#NUM!');
    const out = [];
    for (let i = 0; i < r; i++) {
      const row = [];
      for (let j = 0; j < c; j++) row.push(num(start + (i * c + j) * step));
      out.push(row);
    }
    return out;
  },
  TRANSPOSE: (args) => {
    if (!arity(args, 1)) return err('#VALUE!');
    const g = grid(args[0]);
    return g[0].map((_, j) => g.map((row) => row[j]));
  },
  SORT: (args) => {
    if (!arity(args, 1, 3)) return err('#VALUE!');
    const g = grid(args[0]);
    const col = args.length > 1 ? n(args[1]) : 1;
    if (isErr(col)) return col;
    const asc = args.length > 2 ? toBool(scalar(args[2])) : true;
    if (isErr(asc)) return asc;
    const c = Math.trunc(col) - 1;
    if (c < 0 || c >= g[0].length) return err('#VALUE!');
    for (const row of g) if (isErr(row[c])) return row[c];
    const sorted = [...g].sort((a, b) => compare(a[c], b[c]));
    return asc ? sorted : sorted.reverse();
  },
};
