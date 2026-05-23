// src/commands/list.js
// v0.2 list — 显示订阅类型 + 5h/7d 使用率 + 重置时间
// --refresh 强制实时查询 API
// 当前 Keychain 活跃的帐号前缀 `*`

import { loadConfig, saveConfig, getAccessToken, setLastUsage, setCredentials } from '../config.js';
import { isKeychainSupported, readKeychainRaw, parseClaudeCredentials } from '../keychain.js';
import { queryUsageWithRefresh } from '../oauth.js';

export default async function listCommand(args) {
  const refresh = args.includes('--refresh') || args.includes('-r');
  let config = await loadConfig();

  if (config.accounts.length === 0) {
    console.log('未配置任何帐号。运行 `interval-claude add <name>` 开始。');
    return;
  }

  if (refresh) {
    console.log('正在刷新所有帐号 usage...');
    for (const account of config.accounts) {
      if (!account.credentials) {
        console.log(`  ${account.name}: 跳过（v0.1 token 不支持 usage 查询）`);
        continue;
      }
      try {
        const { usage, credentials } = await queryUsageWithRefresh(account.credentials);
        if (credentials.accessToken !== account.credentials.accessToken) {
          config = setCredentials(config, account.name, credentials);
        }
        config = setLastUsage(config, account.name, usage);
      } catch (err) {
        console.warn(`  ${account.name}: ${err.message}`);
      }
    }
    await saveConfig(config);
    // 重新加载以拿最新数据
    config = await loadConfig();
  }

  // 识别当前 Keychain 活跃帐号
  let activeAccessToken = null;
  if (isKeychainSupported()) {
    try {
      const raw = readKeychainRaw();
      if (raw) activeAccessToken = parseClaudeCredentials(raw).accessToken;
    } catch { /* ignore */ }
  }

  console.log();
  console.log(formatTable(config, activeAccessToken));
  console.log();
  console.log(`interval_minutes=${config.interval_minutes}  共 ${config.accounts.length} 个帐号`);
  if (!refresh) console.log('提示: 使用 --refresh 重新查询所有帐号的 usage');
}

function formatTable(config, activeAccessToken) {
  const headers = ['NAME', 'SUB', '5H USE', 'RESETS', '7D USE', 'STATUS'];
  const rows = [];
  for (const a of config.accounts) {
    const isActive = activeAccessToken && getAccessToken(a) === activeAccessToken;
    const name = (isActive ? '* ' : '  ') + a.name;
    const sub = a.credentials?.subscriptionType ?? (a.legacy_token ? 'v0.1' : '-');
    const fiveH = formatUtil(a.last_usage?.five_hour);
    const resets = formatTimeUntil(a.last_usage?.five_hour?.resets_at);
    const sevenD = formatUtil(a.last_usage?.seven_day);
    const status = formatStatus(a.last_usage?.five_hour);
    rows.push([name, sub, fiveH, resets, sevenD, status]);
  }

  const widths = headers.map((h, i) => Math.max(
    visibleWidth(h),
    ...rows.map(r => visibleWidth(r[i]))
  ));

  const lines = [];
  lines.push(headers.map((h, i) => pad(h, widths[i])).join('  '));
  lines.push(widths.map(w => '─'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
  return lines.join('\n');
}

function formatUtil(u) {
  if (!u || u.utilization == null) return '-';
  return Math.round(u.utilization * 100) + '%';
}

function formatTimeUntil(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `in ${h}h${m}m` : `in ${m}m`;
}

function formatStatus(fiveH) {
  if (!fiveH || fiveH.utilization == null) return '⚪';
  const u = fiveH.utilization;
  if (u >= 0.95) return '🔴';
  if (u >= 0.80) return '🟡';
  return '🟢';
}

function visibleWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // emoji 和中文计 2 字符宽度
    w += cp > 0x2e00 ? 2 : 1;
  }
  return w;
}

function pad(s, w) {
  return s + ' '.repeat(Math.max(0, w - visibleWidth(s)));
}
