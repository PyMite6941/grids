// Runs the shared engine contract (shared/fixtures/formulas.json).
// desktop/test/EngineFixtures.java runs the same file against the Java engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateSheet, fromPlain, isErr } from '../public/engine/index.js';

const fixtures = JSON.parse(readFileSync(new URL('../../shared/fixtures/formulas.json', import.meta.url), 'utf8'));

function check(actual, expected, where) {
  if (expected === null) return assert.equal(actual ?? null, null, where);
  if (typeof expected === 'object' && 'error' in expected) {
    assert.ok(isErr(actual), `${where}: expected ${expected.error}, got ${JSON.stringify(actual)}`);
    return assert.equal(actual.code, expected.error, where);
  }
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${where}: expected ${expected}, got ${JSON.stringify(actual)}`);
    return assert.ok(Math.abs(actual - expected) < 1e-9, `${where}: expected ${expected}, got ${actual}`);
  }
  assert.equal(actual, expected, where);
}

for (const c of fixtures.cases) {
  test(c.name, () => {
    const python = new Map(Object.entries(c.python ?? {}).map(([k, v]) => [k, fromPlain(v)]));
    const { values } = evaluateSheet(c.cells, { python });
    for (const [ref, expected] of Object.entries(c.expect)) check(values.get(ref), expected, `${c.name} ${ref}`);
  });
}
