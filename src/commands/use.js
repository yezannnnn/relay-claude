// src/commands/use.js
// `use <name>` — 原子切换 macOS Keychain 到目标帐号。
//
// 流程:
//   1. 读取当前 Keychain → 找出归属帐号 → 备份其凭证到 config（可能 refresh 过）
//   2. 检查目标 token 是否将过期 → 自动刷新
//   3. 写入目标凭证到 Keychain
//   4. 调一次 usage API 验证 + 缓存到 last_usage

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

export default async function useCommand(args) {
  if (!isKeychainSupported()) {
    console.error('use: 仅支持 macOS');
    process.exit(1);
  }

  const targetName = args[0];
  if (!targetName) {
    console.error('用法: interval-claude use <name>');
    process.exit(1);
  }

  const config = await loadConfig();
  const target = config.accounts.find(a => a.name === targetName);
  if (!target) {
    console.error(`帐号 "${targetName}" 不存在`);
    process.exit(1);
  }
  if (!target.credentials) {
    console.error(`帐号 "${targetName}" 没有 OAuth 凭证（可能是 v0.1 长效 token）`);
    console.error('请运行: claude /logout && claude /login, 然后 interval-claude add ' + targetName + ' 重新捕获');
    process.exit(1);
  }

  // 累积所有 config 修改，最后用 updateConfig 原子写入
  // 避免和 daemon 续期等并发写入互相覆盖
  const patches = [];

  // Step 1: 备份当前 Keychain
  const currentRaw = readKeychainRaw();
  if (currentRaw) {
    try {
      const currentParsed = parseClaudeCredentials(currentRaw);
      const owner = findAccountByAccessToken(config, currentParsed.accessToken);
      if (owner) {
        if (owner.name === targetName) {
          console.log(`Keychain 已经是 ${targetName} 的凭证`);
        } else {
          console.log(`备份当前 Keychain 到帐号: ${owner.name}`);
          patches.push({ type: 'creds', name: owner.name, credentials: currentParsed });
        }
      } else {
        console.warn('⚠️  当前 Keychain 中的 token 不属于已配置帐号，已忽略备份');
      }
    } catch (err) {
      console.warn(`⚠️  解析当前 Keychain 失败: ${err.message}`);
    }
  }

  // Step 2: 如果目标 token 过期，刷新
  let targetCreds = target.credentials;
  if (isExpiringSoon(targetCreds)) {
    console.log(`目标 token 即将过期，正在刷新...`);
    try {
      targetCreds = await refreshAccessToken(targetCreds);
      patches.push({ type: 'creds', name: targetName, credentials: targetCreds });
      console.log('✅ token 已刷新');
    } catch (err) {
      console.error(`token 刷新失败: ${err.message}`);
      console.error(`请运行: claude /logout && claude /login（用 ${targetName} 帐号），然后 interval-claude add ${targetName} 重新捕获`);
      process.exit(1);
    }
  }

  // Step 3: 写入 Keychain
  const newRaw = serializeCredentials(targetCreds, currentRaw);
  writeKeychainRaw(newRaw);

  // Step 4: 查 usage 验证 + 缓存
  let usage = null;
  try {
    usage = await queryUsage(targetCreds.accessToken);
    patches.push({ type: 'usage', name: targetName, usage });
  } catch (err) {
    console.warn(`⚠️  usage 查询失败: ${err.message}`);
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

  console.log(`✅ 已切换到 ${targetName}`);
  console.log(`   订阅: ${targetCreds.subscriptionType || '未知'}`);
  if (usage?.five_hour) {
    const pct = Math.round(usage.five_hour.utilization * 100);
    console.log(`   5h 使用: ${pct}% (剩余 ${100 - pct}%)`);
  }
  console.log('所有终端的 claude 命令立即生效');
}
