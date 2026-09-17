import test from 'node:test';
import assert from 'node:assert/strict';
import { validCallback } from './robinhood-loopback-connect.mjs';

test('accepts only the matching callback state and a single nonempty code', () => {
  const url = path => new URL(path, 'http://127.0.0.1:53682');
  assert.equal(validCallback(url('/callback?state=expected&code=one'), 'expected'), true);
  for (const path of ['/callback?state=wrong&code=one','/callback?state=expected',
    '/callback?state=expected&code=', '/callback?state=expected&code=one&code=two',
    '/callback?state=expected&state=wrong&code=one', '/other?state=expected&code=one']) {
    assert.equal(validCallback(url(path), 'expected'), false);
  }
});
