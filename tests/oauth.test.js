import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isExpiringSoon, CLIENT_ID, queryUsage, queryProfile,
  generatePKCE, buildAuthorizeUrl, exchangeCode,
  AUTHORIZE_URL, REDIRECT_URI, AUTHORIZE_SCOPE,
} from '../src/oauth.js';

// Mock requestFn for normalizeUtilization tests (API returns percentage floats)
function mockUsage(utilization) {
  return async () => ({
    status: 200, ok: true,
    body: JSON.stringify({
      five_hour: { utilization, resets_at: '2026-06-01T20:00:00Z' },
      seven_day: { utilization, resets_at: '2026-06-07T20:00:00Z' },
    }),
  });
}

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

// normalizeUtilization: API returns percentage floats (17.0 = 17%, 1.0 = 1%)
// The boundary v=1.0 must be treated as 1%, NOT as decimal 100%
test('normalizeUtilization: 1.0 from API is 1%, stored as 0.01', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(1.0) });
  // Raw API 1.0 = 1%, must not be treated as 100%
  assert.equal(usage.five_hour.utilization, 0.01);
  assert.equal(usage.seven_day.utilization, 0.01);
});

test('normalizeUtilization: 17.0 from API is 17%, stored as 0.17', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(17.0) });
  assert.equal(usage.five_hour.utilization, 0.17);
});

test('normalizeUtilization: 100.0 from API is 100%, stored as 1.0', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(100.0) });
  assert.equal(usage.five_hour.utilization, 1.0);
});

test('normalizeUtilization: 0.0 stays 0', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(0.0) });
  assert.equal(usage.five_hour.utilization, 0);
});

test('queryUsage: 429 时把 httpStatus 和 retryAfterSec 挂到 error 上', async () => {
  const reqFn = async () => ({
    status: 429,
    ok: false,
    retryAfter: 1334,
    body: '{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}',
  });
  await assert.rejects(
    queryUsage('tok', { requestFn: reqFn }),
    (err) => {
      assert.equal(err.httpStatus, 429);
      assert.equal(err.retryAfterSec, 1334);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// OAuth Authorization Code + PKCE flow
// ─────────────────────────────────────────────────────────────────────────────

test('generatePKCE produces base64url verifier/challenge of valid length', () => {
  const { verifier, challenge } = generatePKCE();
  // base64url 编码 32 字节随机 = 43 字符
  assert.equal(verifier.length, 43);
  assert.equal(challenge.length, 43);
  // base64url 只含 A-Z a-z 0-9 _ -，无 padding
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test('generatePKCE each call returns fresh pair', () => {
  const a = generatePKCE();
  const b = generatePKCE();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.challenge, b.challenge);
});

test('buildAuthorizeUrl 包含所有必需参数，state 复用 verifier', () => {
  const pkce = generatePKCE();
  const url = new URL(buildAuthorizeUrl(pkce));
  assert.equal(url.origin + url.pathname, AUTHORIZE_URL);
  assert.equal(url.searchParams.get('code'), 'true');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), AUTHORIZE_SCOPE);
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // state 复用 verifier — Anthropic authorize endpoint 不接受独立 state
  assert.equal(url.searchParams.get('state'), pkce.verifier);
});

test('exchangeCode 拼装正确的 POST body 并返回标准 credentials', async () => {
  let capturedReq = null;
  const fakeReq = async (opts) => {
    capturedReq = opts;
    return {
      status: 200, ok: true,
      body: JSON.stringify({
        access_token: 'sk-ant-oat01-test-access',
        refresh_token: 'sk-ant-ort01-test-refresh',
        expires_in: 28800,
        scope: 'user:profile user:inference',
      }),
    };
  };
  const before = Date.now();
  const creds = await exchangeCode('CODE_VAL#STATE_VAL', 'verifier_xyz', { requestFn: fakeReq });
  const after = Date.now();

  // 请求 body 校验
  const body = JSON.parse(capturedReq.body);
  assert.equal(body.code, 'CODE_VAL');
  assert.equal(body.state, 'STATE_VAL');
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.client_id, CLIENT_ID);
  assert.equal(body.redirect_uri, REDIRECT_URI);
  assert.equal(body.code_verifier, 'verifier_xyz');
  assert.equal(capturedReq.method, 'POST');
  assert.equal(capturedReq.headers['Content-Type'], 'application/json');

  // 返回 credentials 校验
  assert.equal(creds.accessToken, 'sk-ant-oat01-test-access');
  assert.equal(creds.refreshToken, 'sk-ant-ort01-test-refresh');
  assert.deepEqual(creds.scopes, ['user:profile', 'user:inference']);
  // expiresAt = now + expires_in * 1000，允许 1s 漂移
  assert.ok(creds.expiresAt >= before + 28800 * 1000);
  assert.ok(creds.expiresAt <= after + 28800 * 1000 + 100);
});

test('exchangeCode 拒绝缺少 # 的 callback', async () => {
  await assert.rejects(
    exchangeCode('no-hash-here', 'verifier', { requestFn: async () => ({}) }),
    /格式错误|CODE#STATE/,
  );
});

test('exchangeCode 拒绝空 code 或 空 state', async () => {
  await assert.rejects(
    exchangeCode('#only-state', 'v', { requestFn: async () => ({}) }),
    /缺少 code 或 state/,
  );
  await assert.rejects(
    exchangeCode('only-code#', 'v', { requestFn: async () => ({}) }),
    /缺少 code 或 state/,
  );
});

test('exchangeCode 非 2xx 响应抛错', async () => {
  const fakeReq = async () => ({
    status: 400, ok: false,
    body: '{"error":"invalid_grant"}',
  });
  await assert.rejects(
    exchangeCode('A#B', 'v', { requestFn: fakeReq }),
    /Authorization code exchange failed.*400/,
  );
});

test('queryProfile 抽取 subscriptionType 和 rateLimitTier，去掉 claude_ 前缀', async () => {
  const fakeReq = async () => ({
    status: 200, ok: true,
    body: JSON.stringify({
      account: { email: 'a@x.com', uuid: 'u-1', full_name: 'A' },
      organization: {
        uuid: 'o-1',
        organization_type: 'claude_pro',
        rate_limit_tier: 'default_claude_ai',
      },
    }),
  });
  const p = await queryProfile('tok', { requestFn: fakeReq });
  assert.equal(p.email, 'a@x.com');
  assert.equal(p.accountUuid, 'u-1');
  assert.equal(p.subscriptionType, 'pro');
  assert.equal(p.rateLimitTier, 'default_claude_ai');
});

test('queryProfile 处理缺失 organization_type', async () => {
  const fakeReq = async () => ({
    status: 200, ok: true,
    body: JSON.stringify({
      account: { email: 'a@x.com' },
      organization: { uuid: 'o-1' },
    }),
  });
  const p = await queryProfile('tok', { requestFn: fakeReq });
  assert.equal(p.subscriptionType, null);
  assert.equal(p.rateLimitTier, null);
});

test('exchangeCode 缺失 expires_in 走默认 28800', async () => {
  const fakeReq = async () => ({
    status: 200, ok: true,
    body: JSON.stringify({
      access_token: 'at', refresh_token: 'rt',
      // 故意缺 expires_in
    }),
  });
  const before = Date.now();
  const creds = await exchangeCode('A#B', 'v', { requestFn: fakeReq });
  assert.ok(creds.expiresAt >= before + 28800 * 1000 - 100);
  assert.deepEqual(creds.scopes, []); // 缺 scope 字段时空数组
});
