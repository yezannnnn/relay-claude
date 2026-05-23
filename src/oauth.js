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

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const TOKEN_ENDPOINT = 'https://api.anthropic.com/api/oauth/token';
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
    const args = ['-sS', '-w', '\n__HTTP_STATUS__%{http_code}', '-X', opts.method || 'GET'];
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
      const status = parseInt(stdout.slice(idx + marker.length).trim(), 10);
      const body = stdout.slice(0, idx);
      resolve({ status, body, ok: status >= 200 && status < 300 });
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
    throw new Error(`Usage query failed (${res.status}): ${res.body.slice(0, 200)}`);
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
  return v > 1 ? v / 100 : v;
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
