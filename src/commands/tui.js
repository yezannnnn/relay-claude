// src/commands/tui.js
// 实时多帐号仪表盘 (htop 风格)
//
// 设计:
//   - ↑↓ 移动选中行（反白显示）
//   - Enter 切换到当前选中帐号 (use)
//   - p     ping 当前选中帐号
//   - r     强制刷新所有 usage (API 调用)
//   - q     退出
//   - 每 10s 自动从本地缓存重绘 (倒计时实时变化)，无 API 调用
//   - 仅本地变化时光标回顶覆盖，不清屏，无闪烁

import { loadConfig, saveConfig, getAccessToken, setLastUsage, setCredentials } from '../config.js';
import { daemonStatus } from '../daemon.js';
import { isKeychainSupported, readKeychainRaw, parseClaudeCredentials } from '../keychain.js';
import { queryUsageWithRefresh } from '../oauth.js';
import useCommand from './use.js';
import pingCommand from './ping-cmd.js';

const REFRESH_INTERVAL_MS = 10000;

// ANSI 颜色
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inv: '\x1b[7m',          // 反白（选中行）
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export default async function tuiCommand() {
  process.stdout.write('\x1b[?25l\x1b[2J\x1b[H'); // 隐藏光标 + 清屏

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }

  let cursor = 0;       // 当前选中行索引
  let status = '';      // 底部状态消息（操作反馈）
  let busy = false;
  let timer = null;
  let quitting = false;
  let configCache = null;
  let daemonCache = null;
  let activeAccessToken = null;

  function quit() {
    if (quitting) return;
    quitting = true;
    if (timer) clearInterval(timer);
    process.stdout.write('\x1b[?25h\n');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  }

  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  async function refreshLocal() {
    configCache = await loadConfig();
    daemonCache = await daemonStatus();
    if (isKeychainSupported()) {
      try {
        const raw = readKeychainRaw();
        activeAccessToken = raw ? parseClaudeCredentials(raw).accessToken : null;
      } catch {
        activeAccessToken = null;
      }
    }
    // cursor 越界保护
    const N = configCache.accounts.length;
    if (N === 0) cursor = 0;
    else if (cursor >= N) cursor = N - 1;
    else if (cursor < 0) cursor = 0;
  }

  async function refreshFromAPI() {
    busy = true;
    status = '正在刷新所有帐号 usage...';
    render();
    let config = await loadConfig();
    let okCount = 0;
    let failCount = 0;
    for (const a of config.accounts) {
      if (!a.credentials) continue;
      try {
        const { usage, credentials } = await queryUsageWithRefresh(a.credentials);
        if (credentials.accessToken !== a.credentials.accessToken) {
          config = setCredentials(config, a.name, credentials);
        }
        config = setLastUsage(config, a.name, usage);
        okCount++;
      } catch {
        failCount++;
      }
    }
    await saveConfig(config);
    status = `刷新完成: ${okCount} OK${failCount ? `, ${failCount} 失败` : ''}`;
    busy = false;
    await refreshLocal();
    render();
  }

  async function actionSwitch() {
    if (!configCache || !configCache.accounts[cursor]) return;
    const target = configCache.accounts[cursor];
    busy = true;
    status = `正在切换到 ${target.name}...`;
    render();
    try {
      await useCommand([target.name]);
      status = `已切换到 ${target.name}`;
    } catch (err) {
      status = `切换失败: ${err?.message ?? err}`;
    }
    busy = false;
    await refreshLocal();
    render();
  }

  async function actionPing() {
    if (!configCache || !configCache.accounts[cursor]) return;
    const target = configCache.accounts[cursor];
    busy = true;
    status = `正在 ping ${target.name}...`;
    render();
    try {
      await pingCommand([target.name]);
      status = `ping ${target.name} 完成`;
    } catch (err) {
      status = `ping 失败: ${err?.message ?? err}`;
    }
    busy = false;
    await refreshLocal();
    render();
  }

  process.stdin.on('data', async (key) => {
    if (busy || quitting) return;
    const k = String(key);
    // q / Ctrl+C
    if (k === 'q' || k === '\x03') return quit();
    // ↑
    if (k === '\x1b[A') {
      if (configCache && cursor > 0) {
        cursor--;
        render();
      }
      return;
    }
    // ↓
    if (k === '\x1b[B') {
      if (configCache && cursor < configCache.accounts.length - 1) {
        cursor++;
        render();
      }
      return;
    }
    // Enter
    if (k === '\r' || k === '\n') return actionSwitch();
    if (k === 'p') return actionPing();
    if (k === 'r') return refreshFromAPI();
  });

  function render() {
    if (!configCache) return;
    const lines = [];

    // 标题行
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const daemon = daemonCache?.running
      ? `${C.green}●${C.reset} 运行中 (uptime ${daemonCache.uptime ?? '-'})`
      : `${C.red}●${C.reset} 未运行`;
    lines.push(`${C.bold}intervalClaude${C.reset}    ${C.gray}${now}${C.reset}    Daemon: ${daemon}    ${configCache.accounts.length} accounts`);
    lines.push('');

    // 表头
    const cols = [
      { label: 'NAME', width: 14 },
      { label: 'SUB', width: 8 },
      { label: '5H USAGE', width: 32 },
      { label: '7D', width: 6 },
      { label: 'NEXT', width: 10 },
      { label: 'RESETS', width: 10 },
    ];
    const header = '  ' + cols.map(c => padRight(c.label, c.width)).join(' ');
    lines.push(`${C.bold}${C.dim}${header}${C.reset}`);

    // 数据行
    if (configCache.accounts.length === 0) {
      lines.push(`${C.dim}  (无帐号，运行 interval-claude add <name> 添加)${C.reset}`);
    }
    configCache.accounts.forEach((a, i) => {
      const isActive = activeAccessToken && getAccessToken(a) === activeAccessToken;
      const marker = isActive ? `${C.cyan}*${C.reset}` : ' ';
      const name = padRight(a.name, cols[0].width);
      const sub = padRight(a.credentials?.subscriptionType ?? (a.legacy_token ? 'v0.1' : '-'), cols[1].width);
      const usageBar = fmtUsageBar(a.last_usage?.five_hour, cols[2].width);
      const sevenD = padRight(fmtUtil(a.last_usage?.seven_day), cols[3].width);
      const next = padRight(fmtNextPing(a, daemonCache), cols[4].width);
      const resets = padRight(fmtTimeUntil(a.last_usage?.five_hour?.resets_at), cols[5].width);

      const row = `${marker} ${name} ${sub} ${usageBar} ${sevenD} ${next} ${resets}`;
      if (i === cursor) {
        lines.push(`${C.inv}${row}${C.reset}`);
      } else {
        lines.push(row);
      }
    });

    lines.push('');

    // 状态消息
    if (status) {
      lines.push(`${C.cyan}${status}${C.reset}`);
    } else {
      lines.push('');
    }
    lines.push('');

    // 操作提示
    const helpItems = [
      `${C.bold}↑↓${C.reset} 选择`,
      `${C.bold}Enter${C.reset} 切换`,
      `${C.bold}p${C.reset} ping`,
      `${C.bold}r${C.reset} 刷新`,
      `${C.bold}q${C.reset} 退出`,
    ];
    lines.push(`${C.dim}  ${helpItems.join('   ')}${C.reset}`);

    // 输出：光标回顶覆盖 + 每行末尾 \x1b[K 清到行尾 + 屏幕末尾 \x1b[J 清残留
    process.stdout.write('\x1b[H');
    process.stdout.write(lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  }

  // 启动
  await refreshLocal();
  render();
  timer = setInterval(async () => {
    if (busy) return;
    await refreshLocal();
    render();
  }, REFRESH_INTERVAL_MS);

  // 屏幕大小变化时立刻重画
  process.stdout.on('resize', () => {
    if (!busy) {
      process.stdout.write('\x1b[2J\x1b[H'); // 重置整屏
      render();
    }
  });
}

// === 格式化函数 ===

/**
 * 进度条 + 百分比 + 颜色（绿/黄/红）
 * width = 总字符宽度
 */
function fmtUsageBar(u, width = 32) {
  if (!u || u.utilization == null) {
    return padRight(`${C.dim}-${C.reset}`, width + visibleAnsiOverhead());
  }
  const pct = Math.round(u.utilization * 100);
  const barWidth = 20;
  const filled = Math.round(u.utilization * barWidth);
  const empty = barWidth - filled;
  let color = C.green;
  if (u.utilization >= 0.9) color = C.red;
  else if (u.utilization >= 0.7) color = C.yellow;
  const bar = color + '█'.repeat(filled) + C.dim + '░'.repeat(empty) + C.reset;
  const pctStr = `${pct}%`.padStart(4);
  const text = `${bar} ${color}${pctStr}${C.reset}`;
  // visibleWidth = barWidth + 1 + 4 = 25
  const visible = barWidth + 1 + 4;
  return text + ' '.repeat(Math.max(0, width - visible));
}

function visibleAnsiOverhead() {
  return 0; // 占位
}

function fmtUtil(u) {
  if (!u || u.utilization == null) return '-';
  return `${Math.round(u.utilization * 100)}%`;
}

function fmtNextPing(account, status) {
  if (!status?.running || !status?.startedAt) return '-';
  const startedMs = new Date(status.startedAt).getTime();
  const targetMs = startedMs + (account.offset_minutes ?? 0) * 60000;
  const diff = targetMs - Date.now();
  if (diff <= 0) return '已过';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function fmtTimeUntil(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

function visibleWidth(s) {
  // 去掉 ANSI 转义后计算字符宽度
  const clean = s.replace(/\x1b\[[\d;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    w += ch.codePointAt(0) > 0x2e00 ? 2 : 1;
  }
  return w;
}

function padRight(s, w) {
  const pad = Math.max(0, w - visibleWidth(s));
  return s + ' '.repeat(pad);
}
