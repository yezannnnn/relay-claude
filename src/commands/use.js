// src/commands/use.js
// `use <name>` — 原子切换 macOS Keychain 到目标帐号。
//
// 流程:
//   1. 读取当前 Keychain → 找出归属帐号 → 备份其凭证到 config（可能 refresh 过）
//   2. 检查目标 token 是否将过期 → 自动刷新
//   3. 写入目标凭证到 Keychain
//   4. 调一次 usage API 验证 + 缓存到 last_usage
//
// 导出说明:
//   - useAccount(name, options) — 核心逻辑，出错时抛 Error（可被 daemon 安全调用）
//   - useCommand(args)          — CLI 入口，包 try/catch + process.exit，默认导出

import {
  isKeychainSupported,
  readKeychainRaw,
  writeKeychainRaw,
  parseClaudeCredentials,
  serializeCredentials,
} from '../keychain.js';
import { loadConfig, setCredentials, setLastUsage, updateConfig } from '../config.js';
import { refreshAccessToken, isExpiringSoon, queryUsage } from '../oauth.js';

/** 在 config.accounts 中通过 accessToken 找帐号。 */
export function findAccountByAccessToken(config, accessToken) {
  for (const a of config.accounts) {
    if (a.credentials?.accessToken === accessToken) return a;
    if (a.legacy_token === accessToken) return a;
  }
  return null;
}

/**
 * 核心切换逻辑 — 出错时抛 Error，不调 process.exit。
 * daemon / TUI 内部调用时应用此函数；CLI 入口用 useCommand 包一层。
 *
 * @param {string} name  - 目标帐号名
 * @param {Object} opts
 * @param {Function} [opts.logFn=console.log]  - 日志输出（成功信息）
 * @param {Function} [opts.warnFn=console.warn] - 警告输出（非致命问题）
 * @returns {Promise<{targetCreds: Object, usage: Object|null}>}
 */
export async function useAccount(name, { logFn = console.log, warnFn = console.warn } = {}) {
  if (!isKeychainSupported()) {
    throw new Error('use: 仅支持 macOS');
  }

  const config = await loadConfig();
  const target = config.accounts.find((a) => a.name === name);
  if (!target) {
    throw new Error(`帐号 "${name}" 不存在`);
  }
  if (!target.credentials) {
    throw new Error(
      `帐号 "${name}" 没有 OAuth 凭证（可能是 v0.1 长效 token）\n` +
        `请运行: claude /logout && claude /login, 然后 interval-claude add ${name} 重新捕获`,
    );
  }

  // 累积所有 config 修改，最后用 updateConfig 原子写入
  const patches = [];

  // Step 1: 备份当前 Keychain
  const currentRaw = readKeychainRaw();
  if (currentRaw) {
    try {
      const currentParsed = parseClaudeCredentials(currentRaw);
      const owner = findAccountByAccessToken(config, currentParsed.accessToken);
      if (owner) {
        if (owner.name === name) {
          logFn(`Keychain 已经是 ${name} 的凭证`);
        } else {
          logFn(`备份当前 Keychain 到帐号: ${owner.name}`);
          patches.push({ type: 'creds', name: owner.name, credentials: currentParsed });
        }
      } else {
        warnFn('⚠️  当前 Keychain 中的 token 不属于已配置帐号，已忽略备份');
      }
    } catch (err) {
      warnFn(`⚠️  解析当前 Keychain 失败: ${err.message}`);
    }
  }

  // Step 2: 如果目标 token 过期，刷新
  let targetCreds = target.credentials;
  if (isExpiringSoon(targetCreds)) {
    logFn('目标 token 即将过期，正在刷新...');
    try {
      targetCreds = await refreshAccessToken(targetCreds);
      patches.push({ type: 'creds', name, credentials: targetCreds });
      logFn('✅ token 已刷新');
    } catch (err) {
      throw new Error(
        `token 刷新失败: ${err.message}\n` +
          `请运行: claude /logout && claude /login（用 ${name} 帐号），然后 interval-claude add ${name} 重新捕获`,
      );
    }
  }

  // Step 3: 写入 Keychain
  const newRaw = serializeCredentials(targetCreds, currentRaw);
  writeKeychainRaw(newRaw);

  // Step 4: 查 usage 验证 + 缓存
  let usage = null;
  try {
    usage = await queryUsage(targetCreds.accessToken);
    patches.push({ type: 'usage', name, usage });
  } catch (err) {
    warnFn(`⚠️  usage 查询失败: ${err.message}`);
  }

  // 原子写入所有累积的 patch
  if (patches.length > 0) {
    await updateConfig((cfg) => {
      let next = cfg;
      for (const p of patches) {
        if (p.type === 'creds') next = setCredentials(next, p.name, p.credentials);
        else if (p.type === 'usage') next = setLastUsage(next, p.name, p.usage);
      }
      return next;
    });
  }

  logFn(`✅ 已切换到 ${name}`);
  logFn(`   订阅: ${targetCreds.subscriptionType || '未知'}`);
  if (usage?.five_hour) {
    const pct = Math.round(usage.five_hour.utilization * 100);
    logFn(`   5h 使用: ${pct}% (剩余 ${100 - pct}%)`);
  }
  logFn('所有终端的 claude 命令立即生效');

  return { targetCreds, usage };
}

/**
 * CLI 入口 — 解析 args，出错时打印并 process.exit(1)。
 */
export default async function useCommand(args) {
  const targetName = args[0];
  if (!targetName) {
    console.error('用法: interval-claude use <name>');
    process.exit(1);
  }
  try {
    await useAccount(targetName);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
