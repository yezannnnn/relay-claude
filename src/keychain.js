// src/keychain.js
// macOS Keychain read/write for Claude CLI's "Claude Code-credentials"
//
// Reads/writes the full JSON payload that claude CLI stores.
// Linux/Windows: not supported in v0.2 — callers must check isKeychainSupported() first.

import { execFileSync } from 'node:child_process';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function isKeychainSupported() {
  return process.platform === 'darwin';
}

/**
 * Read raw JSON payload from macOS Keychain.
 * @returns {string|null} - raw JSON string, or null if no entry exists
 * @throws {Error} on unsupported platform
 */
export function readKeychainRaw() {
  if (!isKeychainSupported()) {
    throw new Error('Keychain only supported on macOS in v0.2');
  }
  try {
    const out = execFileSync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-w',
    ], { encoding: 'utf8' });
    return out.trim();
  } catch (err) {
    if (err.status === 44 || /could not be found/i.test(String(err.stderr ?? ''))) {
      return null;
    }
    throw new Error(`Keychain read failed: ${err.message}`);
  }
}

/**
 * Write the full payload back to Keychain (creates or updates).
 * @param {string} rawJson
 */
export function writeKeychainRaw(rawJson) {
  if (!isKeychainSupported()) {
    throw new Error('Keychain only supported on macOS in v0.2');
  }
  execFileSync('security', [
    'add-generic-password',
    '-U',
    '-s', KEYCHAIN_SERVICE,
    '-a', process.env.USER || 'claude',
    '-w', rawJson,
  ], { stdio: 'ignore' });
}

/**
 * Parse the JSON payload and extract Claude OAuth credentials.
 * @param {string} rawJson
 * @returns {Object}
 * @throws {Error} if JSON is invalid or claudeAiOauth field is missing
 */
export function parseClaudeCredentials(rawJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`Invalid Keychain JSON: ${err.message}`);
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error('Keychain payload missing claudeAiOauth field');
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes || [],
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  };
}

/**
 * Serialize credentials back to Keychain JSON shape (preserves mcpOAuth from original).
 * @param {Object} credentials
 * @param {string|null} originalRaw
 * @returns {string}
 */
export function serializeCredentials(credentials, originalRaw = null) {
  let preserved = {};
  if (originalRaw) {
    try {
      const parsed = JSON.parse(originalRaw);
      if (parsed.mcpOAuth) preserved.mcpOAuth = parsed.mcpOAuth;
    } catch {
      // ignore
    }
  }
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      scopes: credentials.scopes,
      subscriptionType: credentials.subscriptionType,
      rateLimitTier: credentials.rateLimitTier,
    },
    ...preserved,
  });
}

/**
 * Convenience: read + parse in one call.
 * @returns {Object|null}
 */
export function readCredentials() {
  const raw = readKeychainRaw();
  if (raw === null) return null;
  return parseClaudeCredentials(raw);
}
