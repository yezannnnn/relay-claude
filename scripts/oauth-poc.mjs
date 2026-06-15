#!/usr/bin/env node
// scripts/oauth-poc.mjs
//
// POC: 用 OAuth Authorization Code + PKCE flow 拿 Claude 订阅 token，
// 验证「每次独立 OAuth flow = 独立 session，不被 claude /login 挤压」假设。
//
// 用法:
//   1) node scripts/oauth-poc.mjs           # 跑 authorize flow，输出 token
//   2) node scripts/oauth-poc.mjs refresh <refresh_token>  # 测试 refresh

import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
// 跟 src/oauth.js 保持一致 — fetch 会被 Anthropic 403，必须用 curl
// token endpoint 在 platform.claude.com，console.anthropic.com 已废弃返 404
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPE = 'org:create_api_key user:profile user:inference';
const USER_AGENT = 'claude-cli/2.0.0';
const OAUTH_BETA = 'oauth-2025-04-20';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildAuthorizeUrl({ verifier, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', verifier);
  return url.toString();
}

// 用 curl 而非 fetch — 同 src/oauth.js 的设计原因（Anthropic 对 fetch UA 403）
function curlPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS', '-w', '\n__HTTP_STATUS__%{http_code}',
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `User-Agent: ${USER_AGENT}`,
      '-H', `anthropic-beta: ${OAUTH_BETA}`,
      '--data-binary', JSON.stringify(body),
      url,
    ];
    const child = spawn('curl', args, { timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`curl 失败 (exit ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      const marker = '\n__HTTP_STATUS__';
      const idx = stdout.lastIndexOf(marker);
      if (idx < 0) {
        reject(new Error(`curl 输出缺少状态标记: ${stdout.slice(0, 200)}`));
        return;
      }
      const status = parseInt(stdout.slice(idx + marker.length).trim(), 10);
      const respBody = stdout.slice(0, idx);
      if (status < 200 || status >= 300) {
        reject(new Error(`HTTP ${status}: ${respBody.slice(0, 400)}`));
        return;
      }
      try { resolve(JSON.parse(respBody)); }
      catch (e) { reject(new Error(`JSON parse failed: ${e.message}\nbody: ${respBody.slice(0, 200)}`)); }
    });
  });
}

async function postJson(body) {
  return curlPostJson(TOKEN_ENDPOINT, body);
}

// 验证 token 是否能调 usage API
async function curlGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS', '-w', '\n__HTTP_STATUS__%{http_code}',
      '-H', `Authorization: Bearer ${accessToken}`,
      '-H', `User-Agent: ${USER_AGENT}`,
      '-H', `anthropic-beta: ${OAUTH_BETA}`,
      '-H', 'Accept: application/json',
      url,
    ];
    const child = spawn('curl', args, { timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`curl 失败 (exit ${code}): ${stderr.slice(0, 200)}`));
        return;
      }
      const idx = stdout.lastIndexOf('\n__HTTP_STATUS__');
      const status = parseInt(stdout.slice(idx + '\n__HTTP_STATUS__'.length).trim(), 10);
      const respBody = stdout.slice(0, idx);
      resolve({ status, body: respBody });
    });
  });
}

async function exchangeCode(callbackValue, verifier) {
  const [code, state] = callbackValue.split('#');
  if (!code) throw new Error('callback 格式错误，应为 CODE#STATE');
  return postJson({
    code,
    state,
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

async function refreshAccessToken(refreshToken) {
  return postJson({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

async function runAuthorize() {
  const pkce = generatePKCE();
  const authUrl = buildAuthorizeUrl(pkce);

  console.log('\n📋 OAuth POC — 拿一个独立 session 的 token\n');
  console.log('1️⃣  打开下面 URL（建议浏览器隐身窗口，登录目标 Claude 帐户）:\n');
  console.log(`   ${authUrl}\n`);
  console.log('2️⃣  授权后页面会显示一串 "CODE#STATE" 字符串');
  console.log('3️⃣  整段复制粘贴回这里（包括 # 号）:\n');

  const rl = createInterface({ input: stdin, output: stdout });
  const callbackValue = (await rl.question('粘贴 CODE#STATE > ')).trim();
  rl.close();

  console.log('\n⏳ 用 PKCE verifier 换 token...');
  const tokens = await exchangeCode(callbackValue, pkce.verifier);

  console.log('\n✅ Step 1 通过：拿到 token\n');
  console.log(JSON.stringify({
    access_token_prefix: tokens.access_token?.slice(0, 25),
    access_token_len: tokens.access_token?.length,
    refresh_token_prefix: tokens.refresh_token?.slice(0, 25),
    refresh_token_len: tokens.refresh_token?.length,
    expires_in: tokens.expires_in,
    expires_in_hours: tokens.expires_in ? (tokens.expires_in / 3600).toFixed(2) : null,
    token_type: tokens.token_type,
    scope: tokens.scope,
  }, null, 2));

  // Step 2: 立刻验证 access_token 能调 usage API（确认是 user OAuth token，不是 setup token）
  console.log('\n⏳ Step 2: 验证 token 能否调 usage API...');
  const usageRes = await curlGet('https://api.anthropic.com/api/oauth/usage', tokens.access_token);
  if (usageRes.status >= 200 && usageRes.status < 300) {
    console.log('✅ Step 2 通过：token 是 user OAuth token，可直接调 usage API\n');
    console.log('   usage 响应:', usageRes.body.slice(0, 300));
  } else {
    console.log(`❌ Step 2 失败：HTTP ${usageRes.status}`);
    console.log('   响应:', usageRes.body.slice(0, 400));
    console.log('   → token 可能是 setup token，不能直接当 user token 用。方案 B 需调整。\n');
  }

  console.log('\n💾 完整 refresh_token（Step 3 验证用，注意保密）:\n');
  console.log(tokens.refresh_token);

  console.log('\n🧪 Step 3: 验证 session 独立性 — 手动操作:');
  console.log('   1. 另开终端: claude /logout && claude /login（登录任意账户）');
  console.log('   2. 回来运行:');
  console.log(`      node scripts/oauth-poc.mjs refresh "${tokens.refresh_token}"`);
  console.log('   3. refresh 成功 → OAuth flow session 独立于 /login ✅ 方案可行');
  console.log('   4. refresh 失败 invalid_grant → 还是被挤了 ❌ 方案 B 不可行\n');
}

async function runRefresh(refreshTok) {
  if (!refreshTok) {
    console.error('用法: node scripts/oauth-poc.mjs refresh <refresh_token>');
    process.exit(1);
  }
  console.log('⏳ 用 refresh_token 调 refresh endpoint...\n');
  try {
    const tokens = await refreshAccessToken(refreshTok);
    console.log('✅ Refresh 成功！session 独立于 /login，方案 B 验证通过 🎉\n');
    console.log(JSON.stringify({
      new_access_token_prefix: tokens.access_token?.slice(0, 25),
      new_refresh_token_prefix: tokens.refresh_token?.slice(0, 25),
      expires_in_hours: (tokens.expires_in / 3600).toFixed(2),
    }, null, 2));
    console.log('\n💡 注意 refresh_token 已 rotate，旧的会失效。新 refresh_token:\n');
    console.log(tokens.refresh_token + '\n');
  } catch (err) {
    console.log('❌ Refresh 失败：' + err.message + '\n');
    console.log('如果错误是 invalid_grant，意味着 OAuth flow token 仍受 /login 挤压。');
    console.log('方案 B 不可行，需要回到决策点讨论 A 或 C。\n');
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const mode = args[0];

if (!mode || mode === 'authorize') {
  await runAuthorize();
} else if (mode === 'refresh') {
  await runRefresh(args[1]);
} else {
  console.error('未知模式。\n用法:');
  console.error('  node scripts/oauth-poc.mjs              # authorize flow');
  console.error('  node scripts/oauth-poc.mjs refresh TOK  # 验证 refresh');
  process.exit(1);
}
