import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKeychainSupported, parseClaudeCredentials } from '../src/keychain.js';

test('isKeychainSupported returns true on darwin', () => {
  if (process.platform === 'darwin') {
    assert.equal(isKeychainSupported(), true);
  } else {
    assert.equal(isKeychainSupported(), false);
  }
});

test('parseClaudeCredentials extracts claudeAiOauth from JSON', () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-abc',
      refreshToken: 'sk-ant-ort01-xyz',
      expiresAt: 1779573809608,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai',
    },
    mcpOAuth: {},
  });
  const result = parseClaudeCredentials(raw);
  assert.equal(result.accessToken, 'sk-ant-oat01-abc');
  assert.equal(result.refreshToken, 'sk-ant-ort01-xyz');
  assert.equal(result.subscriptionType, 'pro');
  assert.deepEqual(result.scopes, ['user:profile', 'user:inference']);
});

test('parseClaudeCredentials throws on missing claudeAiOauth', () => {
  assert.throws(() => parseClaudeCredentials('{"mcpOAuth":{}}'), /claudeAiOauth/);
});

test('parseClaudeCredentials throws on invalid JSON', () => {
  assert.throws(() => parseClaudeCredentials('not json'), /JSON/);
});
