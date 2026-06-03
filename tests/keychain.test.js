import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isKeychainSupported, parseClaudeCredentials, serializeCredentials } from '../src/keychain.js';

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

test('serializeCredentials preserves trustedDeviceToken from original raw', () => {
  // 真实 Claude CLI 的 Keychain 在 claudeAiOauth 之外有 trustedDeviceToken
  // 顶层字段；若 serialize 丢字段，CLI 会要求重新 /login。
  const originalRaw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'old-at',
      refreshToken: 'old-rt',
      expiresAt: 1,
      scopes: ['user:profile'],
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai',
    },
    trustedDeviceToken: 'device-trust-secret',
    mcpOAuth: { foo: 'bar' },
  });
  const newCreds = {
    accessToken: 'new-at',
    refreshToken: 'new-rt',
    expiresAt: 2,
    scopes: ['user:profile'],
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_ai',
  };
  const out = JSON.parse(serializeCredentials(newCreds, originalRaw));
  assert.equal(out.claudeAiOauth.accessToken, 'new-at');
  assert.equal(out.trustedDeviceToken, 'device-trust-secret', 'trustedDeviceToken 必须保留');
  assert.deepEqual(out.mcpOAuth, { foo: 'bar' }, 'mcpOAuth 必须保留');
});

test('serializeCredentials preserves unknown top-level fields (forward-compat)', () => {
  // Claude CLI 可能增加新顶层字段；serialize 不应丢弃它们。
  const originalRaw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'old',
      refreshToken: 'old-rt',
      expiresAt: 1,
      scopes: [],
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai',
    },
    futureUnknownField: { nested: 'value' },
    anotherField: 42,
  });
  const newCreds = {
    accessToken: 'new',
    refreshToken: 'new-rt',
    expiresAt: 2,
    scopes: [],
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_ai',
  };
  const out = JSON.parse(serializeCredentials(newCreds, originalRaw));
  assert.deepEqual(out.futureUnknownField, { nested: 'value' });
  assert.equal(out.anotherField, 42);
});

test('serializeCredentials handles null/malformed originalRaw', () => {
  const creds = {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 1,
    scopes: [],
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_ai',
  };
  // null → 从零构造
  const nullOut = JSON.parse(serializeCredentials(creds, null));
  assert.equal(nullOut.claudeAiOauth.accessToken, 'at');

  // 损坏的 JSON → 不抛错，从零构造
  const badOut = JSON.parse(serializeCredentials(creds, 'not-json{'));
  assert.equal(badOut.claudeAiOauth.accessToken, 'at');
});
