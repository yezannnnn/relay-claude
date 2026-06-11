// src/oauth.js
// OAuth operations: token refresh + usage query
//
// Claude CLI's OAuth client_id is hardcoded in the CLI binary.
// Refresh and usage endpoints are part of the unofficial-but-stable
// Anthropic API used by claude CLI itself.
//
// 实现注意：用 curl 而非 fetch — 原因：
// 1. Anthropic API 在国内常需走代理，curl 自动读 https_proxy 环境变量
// 2. Anthropic 接口对 User-Agent 严格校验（403 forbidden if not claude-cli/*）
// 3. Node fetch 直连无代理时被拒绝，且 UA 设置在某些 Node 版本被覆盖

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';
// Refresh endpoint 不在 api.anthropic.com，在 platform.claude.com
// 通过 strings claude CLI 二进制确认: "https://platform.claude.com/v1/oauth/token"
export const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Authorize / code-exchange 走 console.anthropic.com（与 redirect_uri 同域）
// POC 验证可用，与 TOKEN_ENDPOINT 互不影响
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const EXCHANGE_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
export const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
// ⚠️ 必须带 org:create_api_key — Anthropic authorize endpoint 做 scope 白名单校验，
// 缺它会返 "Authorization failed - Invalid request format"。
// server 在 token 响应里会过滤掉它，实际 access_token 的 scope 只剩 user:*，
// 但请求阶段不能省。POC 实测确认。
export const AUTHORIZE_SCOPE = 'org:create_api_key user:profile user:inference';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const USER_AGENT = 'claude-cli/2.0.0';

const DEFAULT_EXPIRY_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * 用 curl 发请求。
 * @param {Object} opts - {url, method, headers, body}
 * @returns {Promise<{status, body, ok}>}
 */
function curlRequest(opts) {
  return new Promise((resolve, reject) => {
    // -w 末尾追加 retry-after 响应头：%header{} 需 curl ≥ 7.84（macOS 8.x 支持）。
    // 老 curl 不识别会原样输出占位串 → 下面解析时 parseInt 得 NaN → 安全降级为 null。
    const args = [
      '-sS',
      '-w', '\n__HTTP_STATUS__%{http_code}__RETRY_AFTER__%header{retry-after}',
      '-X', opts.method || 'GET',
    ];
    for (const [k, v] of Object.entries(opts.headers || {})) {
      args.push('-H', `${k}: ${v}`);
    }
    if (opts.body) {
      args.push('--data-binary', opts.body);
    }
    args.push(opts.url);

    const child = spawn('curl', args, { timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`curl failed (exit ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      const marker = '\n__HTTP_STATUS__';
      const idx = stdout.lastIndexOf(marker);
      if (idx < 0) {
        reject(new Error(`curl output missing status marker: ${stdout.slice(0, 200)}`));
        return;
      }
      const tail = stdout.slice(idx + marker.length); // "<code>__RETRY_AFTER__<value>"
      const [statusStr, retryStr] = tail.split('__RETRY_AFTER__');
      const status = parseInt(statusStr.trim(), 10);
      const retryNum = retryStr ? parseInt(retryStr.trim(), 10) : NaN;
      const retryAfter = Number.isFinite(retryNum) && retryNum > 0 ? retryNum : null;
      const body = stdout.slice(0, idx);
      resolve({ status, body, ok: status >= 200 && status < 300, retryAfter });
    });
  });
}

export function isExpiringSoon(credentials, thresholdMs = DEFAULT_EXPIRY_THRESHOLD_MS) {
  if (!credentials || !credentials.expiresAt) return true;
  return credentials.expiresAt - Date.now() < thresholdMs;
}

export async function refreshAccessToken(credentials, options = {}) {
  const requestFn = options.requestFn ?? curlRequest;
  if (!credentials.refreshToken) {
    throw new Error('Missing refreshToken — cannot refresh');
  }
  const res = await requestFn({
    url: TOKEN_ENDPOINT,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA_HEADER,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${res.body.slice(0, 200)}`);
  }
  const data = JSON.parse(res.body);
  return {
    ...credentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || credentials.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
  };
}

export async function queryUsage(accessToken, options = {}) {
  const requestFn = options.requestFn ?? curlRequest;
  const res = await requestFn({
    url: USAGE_ENDPOINT,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
  if (res.status === 401) {
    throw Object.assign(new Error(`Usage query unauthorized: ${res.body.slice(0, 200)}`), {
      code: 'UNAUTHORIZED',
    });
  }
  if (!res.ok) {
    // 把 HTTP 状态和 retry-after（秒）挂到 error 上，供 daemon 做退避调度，
    // 而不是靠正则去解析 message。
    throw Object.assign(new Error(`Usage query failed (${res.status}): ${res.body.slice(0, 200)}`), {
      httpStatus: res.status,
      retryAfterSec: res.retryAfter ?? null,
    });
  }
  const data = JSON.parse(res.body);
  return {
    five_hour: data.five_hour ? {
      utilization: normalizeUtilization(data.five_hour.utilization),
      resets_at: data.five_hour.resets_at,
    } : null,
    seven_day: data.seven_day ? {
      utilization: normalizeUtilization(data.seven_day.utilization),
      resets_at: data.seven_day.resets_at,
    } : null,
    seven_day_opus: data.seven_day_opus ? {
      utilization: normalizeUtilization(data.seven_day_opus.utilization),
      resets_at: data.seven_day_opus.resets_at,
    } : null,
    seven_day_sonnet: data.seven_day_sonnet ? {
      utilization: normalizeUtilization(data.seven_day_sonnet.utilization),
      resets_at: data.seven_day_sonnet.resets_at,
    } : null,
    extra_usage: data.extra_usage ?? null,
    fetched_at: new Date().toISOString(),
  };
}

function normalizeUtilization(v) {
  if (v == null) return null;
  // API returns percentage floats (e.g. 17.0 = 17%, 1.0 = 1%).
  // Values in [0, 1) are already decimal (0.0 = 0%); exactly 1.0 is also
  // a percentage (1%), so we divide at >= 1, not > 1.
  return v >= 1 ? v / 100 : v;
}

/**
 * 查询帐号 profile（用于 TUI 展示 + 稳定身份识别）。返回 null 表示查询失败。
 *
 * accountUuid 是稳定的账户身份，用于 Keychain ↔ config 匹配:
 *   Anthropic 用 rotating refresh tokens，每次 refresh access/refresh 都会变 →
 *   只用 token 字符串匹配会失效。account.uuid 是不变的身份锚。
 */
export async function queryProfile(accessToken, options = {}) {
  const requestFn = options.requestFn ?? curlRequest;
  try {
    const res = await requestFn({
      url: PROFILE_ENDPOINT,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
    });
    if (!res.ok) return null;
    const data = JSON.parse(res.body);
    // organization_type 是 "claude_pro"/"claude_max"，切掉 claude_ 前缀
    // 与 keychain 里 claude CLI 自己写的 subscriptionType ('pro'/'max') 风格一致
    const orgType = data.organization?.organization_type ?? null;
    const subscriptionType = typeof orgType === 'string'
      ? orgType.replace(/^claude_/, '')
      : null;
    return {
      email: data.account?.email ?? null,
      fullName: data.account?.full_name ?? null,
      accountUuid: data.account?.uuid ?? null,
      organizationUuid: data.organization?.uuid ?? null,
      subscriptionType,
      rateLimitTier: data.organization?.rate_limit_tier ?? null,
    };
  } catch {
    return null;
  }
}

export async function queryUsageWithRefresh(credentials, options = {}) {
  try {
    const usage = await queryUsage(credentials.accessToken, options);
    return { usage, credentials };
  } catch (err) {
    if (err.code !== 'UNAUTHORIZED') throw err;
    const refreshed = await refreshAccessToken(credentials, options);
    const usage = await queryUsage(refreshed.accessToken, options);
    return { usage, credentials: refreshed };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth Authorization Code + PKCE flow
// 用于 add 命令直接拿独立 session 的 token，绕开 claude CLI /login 的同 client_id
// 单活 session 策略（连续 /login 多账户时旧账户 refresh_token 被服务端失效）。
// POC 验证: scripts/oauth-poc.mjs (2026-06-08)。
// ─────────────────────────────────────────────────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** 生成 PKCE verifier/challenge 对（S256）。 */
export function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * 构造 authorize URL — 用户在浏览器打开后，授权页会显示 CODE#STATE 让用户粘贴。
 *
 * 注意 state 设计:
 *   state 复用 PKCE verifier（与 multi-auth 项目和 POC 保持一致）。
 *   独立 state 会让 Anthropic authorize endpoint 返回 "Invalid request format"。
 *   CLI 场景下 CSRF 攻击面有限（用户自浏览器登录 + 自终端粘贴 code），
 *   state 防护的实际价值小，复用 verifier 是 acceptable trade-off。
 *   PKCE code_verifier 校验仍正常运作 → 攻击者拿不到 verifier 就换不到 token。
 *
 * @param {{verifier: string, challenge: string}} pkce
 * @returns {string}
 */
export function buildAuthorizeUrl(pkce) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', AUTHORIZE_SCOPE);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pkce.verifier);
  return url.toString();
}

/**
 * 用 authorize code 换 access/refresh token。
 * @param {string} callbackValue - 用户粘贴的 "CODE#STATE" 串
 * @param {string} verifier - 同次 PKCE 生成的 verifier（同时充当 state）
 * @param {Object} [options.requestFn] - 测试注入
 * @returns {Promise<Object>} credentials 结构（同 keychain parseClaudeCredentials 输出）
 */
export async function exchangeCode(callbackValue, verifier, options = {}) {
  const requestFn = options.requestFn ?? curlRequest;
  const sepIdx = callbackValue.indexOf('#');
  if (sepIdx < 0) {
    throw new Error('callback 格式错误，应为 CODE#STATE');
  }
  const code = callbackValue.slice(0, sepIdx);
  const state = callbackValue.slice(sepIdx + 1);
  if (!code || !state) {
    throw new Error('callback 串缺少 code 或 state');
  }
  const res = await requestFn({
    url: EXCHANGE_ENDPOINT,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA_HEADER,
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Authorization code exchange failed (${res.status}): ${res.body.slice(0, 200)}`);
  }
  const data = JSON.parse(res.body);
  // 转成 keychain.parseClaudeCredentials 同结构 — 让下游代码无需区分 token 来源
  const scopes = typeof data.scope === 'string' ? data.scope.split(' ').filter(Boolean) : [];
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
    scopes,
    subscriptionType: null, // OAuth 返回不含订阅类型，由后续 queryProfile/queryUsage 填
    rateLimitTier: null,
  };
}
