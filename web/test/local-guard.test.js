import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyEditAllowed, localOnly } from '../lib/local-guard.js';

const req = (headers) => ({ headers: { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'content-type': 'application/json', ...headers } });
const local = { bindHost: '127.0.0.1', flag: undefined };

test('same-origin JSON on a local server may edit keys', () => {
  assert.equal(keyEditAllowed(req({}), local), true);
  assert.equal(keyEditAllowed(req({ 'content-type': 'application/json; charset=utf-8' }), local), true);
  assert.equal(keyEditAllowed(req({ host: 'localhost:5173', origin: 'http://localhost:5173' }), local), true);
});

test('cross-site, rebinding, form posts and public servers are refused', () => {
  assert.equal(keyEditAllowed(req({ origin: 'https://evil.example' }), local), false);
  assert.equal(keyEditAllowed(req({ origin: undefined }), local), false);
  assert.equal(keyEditAllowed(req({ host: 'evil.example:5173', origin: 'http://evil.example:5173' }), local), false);
  assert.equal(keyEditAllowed(req({ 'content-type': 'text/plain' }), local), false);
  assert.equal(keyEditAllowed(req({ 'content-type': 'application/jsonp' }), local), false);
  assert.equal(keyEditAllowed(req({}), { bindHost: '0.0.0.0', flag: undefined }), false);
  assert.equal(keyEditAllowed(req({}), { bindHost: '127.0.0.1', flag: '0' }), false);
});

test('feature flags default to on only for loopback binds', () => {
  assert.equal(localOnly(undefined, '127.0.0.1'), true);
  assert.equal(localOnly(undefined, '0.0.0.0'), false);
  assert.equal(localOnly('1', '0.0.0.0'), true);
  assert.equal(localOnly('0', 'localhost'), false);
});
