// Formula text (without the leading "=") -> AST.
// Grammar and precedence are specified in shared/FORMULAS.md.
//
// AST nodes:
//   {t:'num', v} {t:'str', v} {t:'bool', v}
//   {t:'ref', col, row} {t:'range', c1, r1, c2, r2}
//   {t:'call', name, args} {t:'bin', op, l, r} {t:'neg', e} {t:'pct', e}

import { parseRef, MAX_RANGE_CELLS } from './refs.js';

export class ParseError extends Error {}

const NUM = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const REF = /^\$?[A-Za-z]{1,3}\$?[0-9]+/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_.]*/;
const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '%', '(', ')', ',', ':'];

export function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = src.slice(i);
    if (ch === '"') {
      let s = '';
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new ParseError('Unterminated string');
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    let m;
    if ((m = NUM.exec(rest))) {
      out.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    // A ref-shaped word followed by "(" is a function name (LOG10, ATAN2...)
    if ((m = REF.exec(rest)) && src[i + m[0].length] !== '(' && !IDENT.test(src.slice(i + m[0].length))) {
      out.push({ k: 'ref', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = IDENT.exec(rest))) {
      out.push({ k: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => rest.startsWith(o));
    if (!op) throw new ParseError(`Unexpected character "${ch}"`);
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

export function parseFormula(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...ops) => peek().k === 'op' && ops.includes(peek().v);
  const take = () => toks[p++];
  const expect = (v) => {
    if (!isOp(v)) throw new ParseError(`Expected "${v}"`);
    take();
  };

  function comparison() {
    let l = concat();
    while (isOp('=', '<>', '<', '>', '<=', '>=')) l = { t: 'bin', op: take().v, l, r: concat() };
    return l;
  }
  function concat() {
    let l = additive();
    while (isOp('&')) { take(); l = { t: 'bin', op: '&', l, r: additive() }; }
    return l;
  }
  function additive() {
    let l = term();
    while (isOp('+', '-')) l = { t: 'bin', op: take().v, l, r: term() };
    return l;
  }
  function term() {
    let l = power();
    while (isOp('*', '/')) l = { t: 'bin', op: take().v, l, r: power() };
    return l;
  }
  function power() {
    let l = unary();
    while (isOp('^')) { take(); l = { t: 'bin', op: '^', l, r: unary() }; }
    return l;
  }
  function unary() {
    if (isOp('-')) { take(); return { t: 'neg', e: unary() }; }
    if (isOp('+')) { take(); return unary(); }
    return postfix();
  }
  function postfix() {
    let e = primary();
    while (isOp('%')) { take(); e = { t: 'pct', e }; }
    return e;
  }
  function primary() {
    const tok = take();
    switch (tok.k) {
      case 'num': return { t: 'num', v: tok.v };
      case 'str': return { t: 'str', v: tok.v };
      case 'ref': {
        const a = parseRef(tok.v);
        if (!a) throw new ParseError(`Bad reference ${tok.v}`);
        if (isOp(':')) {
          take();
          const t2 = take();
          const b = t2.k === 'ref' ? parseRef(t2.v) : null;
          if (!b) throw new ParseError('Bad range');
          const r = {
            t: 'range',
            c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row),
            c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row),
          };
          if ((r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1) > MAX_RANGE_CELLS) throw new ParseError('Range too large');
          return r;
        }
        return { t: 'ref', col: a.col, row: a.row };
      }
      case 'ident': {
        const name = tok.v.toUpperCase();
        if (isOp('(')) {
          take();
          const args = [];
          if (!isOp(')')) {
            args.push(comparison());
            while (isOp(',')) { take(); args.push(comparison()); }
          }
          expect(')');
          return { t: 'call', name, args };
        }
        if (name === 'TRUE' || name === 'FALSE') return { t: 'bool', v: name === 'TRUE' };
        throw new ParseError(`Unknown name ${tok.v}`);
      }
      case 'op':
        if (tok.v === '(') {
          const e = comparison();
          expect(')');
          return e;
        }
        throw new ParseError(`Unexpected "${tok.v}"`);
      default:
        throw new ParseError('Unexpected end of formula');
    }
  }

  const ast = comparison();
  if (peek().k !== 'eof') throw new ParseError(`Unexpected "${peek().v}"`);
  return ast;
}
