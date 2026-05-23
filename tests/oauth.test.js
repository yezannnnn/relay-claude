import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpiringSoon, CLIENT_ID } from '../src/oauth.js';

test('CLIENT_ID is the known claude CLI uuid', () => {
  assert.equal(CLIENT_ID, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
});

test('isExpiringSoon returns true for past expiresAt', () => {
  const credentials = { expiresAt: Date.now() - 1000 };
  assert.equal(isExpiringSoon(credentials), true);
});

test('isExpiringSoon returns true within threshold', () => {
  const credentials = { expiresAt: Date.now() + 5 * 60 * 1000 };
  assert.equal(isExpiringSoon(credentials), true);
});

test('isExpiringSoon returns false beyond threshold', () => {
  const credentials = { expiresAt: Date.now() + 30 * 60 * 1000 };
  assert.equal(isExpiringSoon(credentials), false);
});

test('isExpiringSoon returns true for missing expiresAt', () => {
  assert.equal(isExpiringSoon({}), true);
  assert.equal(isExpiringSoon({ expiresAt: null }), true);
});
