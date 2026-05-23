import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAccountByAccessToken } from '../src/commands/use.js';

test('findAccountByAccessToken matches credentials.accessToken', () => {
  const config = {
    accounts: [
      { name: 'a', credentials: { accessToken: 'token-a' } },
      { name: 'b', credentials: { accessToken: 'token-b' } },
    ],
  };
  assert.equal(findAccountByAccessToken(config, 'token-b')?.name, 'b');
  assert.equal(findAccountByAccessToken(config, 'token-a')?.name, 'a');
});

test('findAccountByAccessToken matches legacy_token', () => {
  const config = {
    accounts: [
      { name: 'a', credentials: { accessToken: 'token-a' } },
      { name: 'c', legacy_token: 'token-c' },
    ],
  };
  assert.equal(findAccountByAccessToken(config, 'token-c')?.name, 'c');
});

test('findAccountByAccessToken returns null when no match', () => {
  const config = {
    accounts: [{ name: 'a', credentials: { accessToken: 'token-a' } }],
  };
  assert.equal(findAccountByAccessToken(config, 'nope'), null);
});
