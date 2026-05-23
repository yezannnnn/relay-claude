// src/oauth.js
// OAuth operations: token refresh + usage query
//
// Claude CLI's OAuth client_id is hardcoded in the CLI binary.
// Refresh and usage endpoints are part of the unofficial-but-stable
// Anthropic API used by claude CLI itself.

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const TOKEN_ENDPOINT = 'https://api.anthropic.com/api/oauth/token';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

const DEFAULT_EXPIRY_THRESHOLD_MS = 10 * 60 * 1000;

export function isExpiringSoon(credentials, thresholdMs = DEFAULT_EXPIRY_THRESHOLD_MS) {
  if (!credentials || !credentials.expiresAt) return true;
  return credentials.expiresAt - Date.now() < thresholdMs;
}

export async function refreshAccessToken(credentials, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  if (!credentials.refreshToken) {
    throw new Error('Missing refreshToken — cannot refresh');
  }
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-beta': OAUTH_BETA_HEADER,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    ...credentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || credentials.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
  };
}

export async function queryUsage(accessToken, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const res = await fetchFn(USAGE_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      Accept: 'application/json',
    },
  });
  if (res.status === 401) {
    const body = await res.text();
    throw Object.assign(new Error(`Usage query unauthorized: ${body.slice(0, 200)}`), {
      code: 'UNAUTHORIZED',
    });
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Usage query failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json();
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
