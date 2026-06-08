// v0.4 add — 走自实现 OAuth Authorization Code + PKCE flow 拿独立 session
// 每次 add 产生独立 OAuth session，互不挤压，可任意多账户共存。
// 三种模式：
//   1. 无参数 → 交互式批量添加
//   2. 单个 name → 单条捕获
//   3. --offset N → 覆盖自动计算的 offset

import { loadConfig, addAccount, setLastUsage, setCredentials, setAccountUuid, updateConfig } from '../config.js';
import { isKeychainSupported } from '../keychain.js';
import { queryUsage, queryProfile, generatePKCE, generateState, buildAuthorizeUrl, exchangeCode } from '../oauth.js';
import { prompt as ask, closePrompt as close } from './prompt.js';

export default async function addCommand(args) {
  // use/daemon 流程仍依赖 Keychain swap 切账户，所以非 macOS 配完也用不了
  if (!isKeychainSupported()) {
    console.error('add: 暂只支持 macOS（use/daemon 依赖 Keychain）。Linux/Windows 请等后续版本。');
    process.exit(1);
  }

  const positional = args.filter(a => !a.startsWith('--'));
  const offsetIdx = args.indexOf('--offset');
  const offsetMinutes = offsetIdx >= 0 ? parseInt(args[offsetIdx + 1], 10) : null;

  console.log('ℹ️  v0.4: add 改用浏览器 OAuth flow，不再需要先 claude /login');

  if (positional.length === 0) {
    return interactiveBatch();
  }
  const name = positional[0];
  try {
    await captureOne(name, { offsetMinutes });
  } catch (err) {
    console.error(`添加 ${name} 失败: ${err.message}`);
    close();
    process.exit(1);
  }
  close();
}

async function captureOne(name, { offsetMinutes }) {
  const config = await loadConfig();
  const existing = config.accounts.find((a) => a.name === name);
  const isUpdate = !!existing;

  if (isUpdate) {
    console.log(`帐号 "${name}" 已存在 — 进入更新模式`);
  }

  // OAuth Authorization Code + PKCE flow — 拿独立 session，不挤压其他账户
  const pkce = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizeUrl(pkce, state);
  console.log('\n👉 请在浏览器打开下面 URL（推荐隐身窗口）:\n');
  console.log(`   ${authUrl}\n`);
  console.log(`登录目标帐号 "${name}"，授权后页面会显示一串 "CODE#STATE"`);
  const callbackValue = (await ask('粘贴 CODE#STATE > ')).trim();
  if (!callbackValue) {
    throw new Error('未输入 CODE#STATE，已取消');
  }

  const credentials = await exchangeCode(callbackValue, pkce.verifier, state);

  // 验证 + 拉一次 usage + 拉邮箱
  let usage = null;
  try {
    usage = await queryUsage(credentials.accessToken);
  } catch (err) {
    console.warn(`⚠️  usage 查询失败 (${err.message})。继续保存帐号但无 usage 数据。`);
  }

  const profile = await queryProfile(credentials.accessToken);
  if (profile?.email) {
    credentials = { ...credentials, email: profile.email };
  }

  // 在 updateConfig 里 reload + patch，避免和 daemon 续期等并发写入互相覆盖
  await updateConfig((cfg) => {
    const existing = cfg.accounts.find((a) => a.name === name);
    let next;
    if (existing) {
      next = setCredentials(cfg, name, credentials);
    } else {
      const autoOffset =
        offsetMinutes ?? cfg.accounts.length * (cfg.interval_minutes || 100);
      next = addAccount(cfg, { name, credentials, offsetMinutes: autoOffset });
    }
    if (usage) next = setLastUsage(next, name, usage);
    if (profile?.accountUuid) next = setAccountUuid(next, name, profile.accountUuid);
    return next;
  });

  console.log(`✅ ${isUpdate ? '已更新' : '已添加'} ${name}`);
  if (credentials.email) console.log(`   邮箱: ${credentials.email}`);
  console.log(`   订阅: ${credentials.subscriptionType || '未知'}`);
  if (usage?.five_hour) {
    const pct = Math.round(usage.five_hour.utilization * 100);
    console.log(`   5h 使用: ${pct}% (剩余 ${100 - pct}%)`);
    console.log(`   重置时间: ${usage.five_hour.resets_at}`);
  }
  if (usage?.seven_day) {
    const pct = Math.round(usage.seven_day.utilization * 100);
    console.log(`   7天使用: ${pct}%`);
  }
}

async function interactiveBatch() {
  let count = 0;
  while (true) {
    const cont = await ask(`准备好登录第 ${count + 1} 个帐号? [Y/n]: `);
    if (cont.toLowerCase() === 'n') break;
    const name = await ask('帐号名: ');
    if (!name.trim()) {
      console.log('帐号名不能为空，跳过');
      continue;
    }
    try {
      await captureOne(name.trim(), { offsetMinutes: null });
      count++;
    } catch (err) {
      console.error(`添加 ${name} 失败: ${err.message}`);
    }
  }
  close();
  if (count > 0) {
    console.log(`\n✅ 共添加 ${count} 个帐号`);
  } else {
    console.log('没有添加任何帐号');
  }
}
