// v0.2 add — 从 macOS Keychain 捕获 OAuth credentials
// 三种模式：
//   1. 无参数 → 交互式批量添加
//   2. 单个 name → 单条捕获
//   3. --offset N → 覆盖自动计算的 offset

import { loadConfig, saveConfig, addAccount, setLastUsage } from '../config.js';
import { readCredentials, isKeychainSupported } from '../keychain.js';
import { queryUsage } from '../oauth.js';
import { prompt as ask, closePrompt as close } from './prompt.js';

export default async function addCommand(args) {
  if (!isKeychainSupported()) {
    console.error('add: 暂只支持 macOS（依赖 Keychain）。Linux/Windows 请等 v0.3。');
    process.exit(1);
  }

  const positional = args.filter(a => !a.startsWith('--'));
  const offsetIdx = args.indexOf('--offset');
  const offsetMinutes = offsetIdx >= 0 ? parseInt(args[offsetIdx + 1], 10) : null;

  if (positional.length === 0) {
    return interactiveBatch();
  }
  const name = positional[0];
  await captureOne(name, { offsetMinutes });
  close();
}

async function captureOne(name, { offsetMinutes }) {
  const config = await loadConfig();
  if (config.accounts.some(a => a.name === name)) {
    console.error(`帐号 "${name}" 已存在`);
    process.exit(1);
  }

  console.log(`请先运行: claude /logout && claude /login`);
  console.log(`（登录目标帐号 "${name}"）`);
  console.log(`登录完成后按回车继续...`);
  await ask('');

  let credentials;
  try {
    credentials = readCredentials();
  } catch (err) {
    console.error(`读取 Keychain 失败: ${err.message}`);
    process.exit(1);
  }
  if (!credentials) {
    console.error('Keychain 中未找到 claude CLI 凭证。请确认已运行 claude /login。');
    process.exit(1);
  }

  // 验证 + 拉一次 usage
  let usage = null;
  try {
    usage = await queryUsage(credentials.accessToken);
  } catch (err) {
    console.warn(`⚠️  usage 查询失败 (${err.message})。继续保存帐号但无 usage 数据。`);
  }

  const autoOffset = offsetMinutes ?? (config.accounts.length * (config.interval_minutes || 100));
  let newConfig = addAccount(config, { name, credentials, offsetMinutes: autoOffset });
  if (usage) newConfig = setLastUsage(newConfig, name, usage);
  await saveConfig(newConfig);

  console.log(`✅ 已添加 ${name}`);
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
