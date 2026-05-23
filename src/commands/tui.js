// src/commands/tui.js
// 实时多帐号仪表盘
//
// 自动刷新：每 5 秒读 config.last_usage（不调 API）
// 按键: r=API 刷新  u=切换帐号  p=ping  q=退出  s=启动 daemon

import { loadConfig, saveConfig, getAccessToken, setLastUsage, setCredentials } from '../config.js';
import { daemonStatus, startDaemon } from '../daemon.js';
import { isKeychainSupported, readKeychainRaw, parseClaudeCredentials } from '../keychain.js';
import { queryUsageWithRefresh } from '../oauth.js';
import useCommand from './use.js';
import pingCommand from './ping-cmd.js';

const REFRESH_INTERVAL_MS = 5000;

export default async function tuiCommand() {
  process.stdout.write('\x1b[?25l'); // 隐藏光标

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }

  let busy = false;
  let timer = null;
  let quitting = false;

  function quit() {
    if (quitting) return;
    quitting = true;
    if (timer) clearInterval(timer);
    process.stdout.write('\x1b[?25h\n'); // 恢复光标 + 换行
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  }

  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  async function forceRefresh() {
    busy = true;
    let config = await loadConfig();
    for (const a of config.accounts) {
      if (!a.credentials) continue;
      try {
        const { usage, credentials } = await queryUsageWithRefresh(a.credentials);
        if (credentials.accessToken !== a.credentials.accessToken) {
          config = setCredentials(config, a.name, credentials);
        }
        config = setLastUsage(config, a.name, usage);
      } catch {
        // 忽略单帐号失败
      }
    }
    await saveConfig(config);
    busy = false;
    await render();
  }

  async function interactiveSwitch() {
    const config = await loadConfig();
    const name = await pickAccount(config, '切换到:');
    if (!name) return render();
    busy = true;
    try { await useCommand([name]); } catch { /* ignore */ }
    busy = false;
    await render();
  }

  async function interactivePing() {
    const config = await loadConfig();
    const name = await pickAccount(config, '手动 ping:');
    if (!name) return render();
    busy = true;
    try { await pingCommand([name]); } catch { /* ignore */ }
    busy = false;
    await render();
  }

  async function startInteractive() {
    busy = true;
    await startDaemon();
    busy = false;
    await render();
  }

  process.stdin.on('data', async (key) => {
    if (busy || quitting) return;
    const k = String(key);
    if (k === 'q' || k === '\x03') return quit();
    if (k === 'r') return forceRefresh();
    if (k === 'u') return interactiveSwitch();
    if (k === 'p') return interactivePing();
    if (k === 's') return startInteractive();
  });

  // 启动刷新循环
  await render();
  timer = setInterval(() => { if (!busy) render(); }, REFRESH_INTERVAL_MS);
}

/** 暂停 raw mode，让用户输入数字选帐号，然后恢复。 */
async function pickAccount(config, title) {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[2J\x1b[H'); // 清屏
  console.log(title);
  config.accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}`));
  process.stdout.write('选择编号（空回车取消）: ');
  const choice = await new Promise((resolve) => {
    let buf = '';
    function onData(data) {
      const s = String(data);
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.removeListener('data', onData);
          resolve(buf.trim());
          return;
        }
        buf += ch;
      }
    }
    process.stdin.on('data', onData);
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const idx = parseInt(choice, 10) - 1;
  return config.accounts[idx]?.name ?? null;
}

async function render() {
  const config = await loadConfig();
  const status = await daemonStatus();

  let activeAccessToken = null;
  if (isKeychainSupported()) {
    try {
      const raw = readKeychainRaw();
      if (raw) activeAccessToken = parseClaudeCredentials(raw).accessToken;
    } catch { /* ignore */ }
  }

  const headerText = status.running
    ? `intervalClaude · 守护进程运行中 (uptime ${status.uptime ?? '-'})`
    : 'intervalClaude · 守护进程未运行 — 按 [s] 启动';

  // 行宽（不算左右边框）
  const W = 76;
  const lines = [];
  lines.push('┌─ ' + truncate(headerText, W - 4) + padRight('', W - 4 - visibleWidth(truncate(headerText, W - 4))) + ' ─┐');
  lines.push(border('│', W, '│'));

  const cols = [
    { label: 'NAME', width: 14 },
    { label: 'SUB', width: 8 },
    { label: '5H USE', width: 14 },
    { label: '7D USE', width: 8 },
    { label: 'NEXT', width: 12 },
    { label: 'RESETS', width: 14 },
  ];
  const headerRow = cols.map(c => padRight(c.label, c.width)).join(' ');
  lines.push('│  ' + headerRow + padRight('', W - 2 - visibleWidth(headerRow)) + '│');
  lines.push('│  ' + cols.map(c => '─'.repeat(c.width)).join(' ') + padRight('', W - 2 - cols.reduce((s, c) => s + c.width + 1, -1)) + '│');

  for (const a of config.accounts) {
    const isActive = activeAccessToken && getAccessToken(a) === activeAccessToken;
    const cells = [
      padRight((isActive ? '* ' : '  ') + a.name, cols[0].width),
      padRight(a.credentials?.subscriptionType ?? (a.legacy_token ? 'v0.1' : '-'), cols[1].width),
      padRight(fmtUsageBar(a.last_usage?.five_hour), cols[2].width),
      padRight(fmtUtil(a.last_usage?.seven_day), cols[3].width),
      padRight(fmtNextPing(a, status), cols[4].width),
      padRight(fmtTimeUntil(a.last_usage?.five_hour?.resets_at), cols[5].width),
    ];
    const row = cells.join(' ');
    lines.push('│  ' + row + padRight('', W - 2 - visibleWidth(row)) + '│');
  }

  lines.push(border('│', W, '│'));
  const activeName = config.accounts.find(a => activeAccessToken && getAccessToken(a) === activeAccessToken)?.name ?? '(未知)';
  const footer = `当前 Keychain: ${activeName}`;
  lines.push('│  ' + footer + padRight('', W - 2 - visibleWidth(footer)) + '│');
  lines.push(border('│', W, '│'));

  const keys = status.running
    ? '[r] 刷新  [u] 切换  [p] ping  [q] 退出'
    : '[s] 启动 daemon  [u] 切换  [q] 退出';
  lines.push('│  ' + keys + padRight('', W - 2 - visibleWidth(keys)) + '│');
  lines.push('└' + '─'.repeat(W) + '┘');

  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(lines.join('\n') + '\n');
}

function border(L, W, R) {
  return L + ' '.repeat(W) + R;
}

function fmtUsageBar(u) {
  if (!u || u.utilization == null) return '-';
  const pct = Math.round(u.utilization * 100);
  const filled = Math.round(u.utilization * 5);
  return '█'.repeat(filled) + '░'.repeat(5 - filled) + ' ' + pct + '%';
}

function fmtUtil(u) {
  if (!u || u.utilization == null) return '-';
  return Math.round(u.utilization * 100) + '%';
}

function fmtNextPing(account, status) {
  if (!status.running || !status.startedAt) return '-';
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

function truncate(s, w) {
  if (visibleWidth(s) <= w) return s;
  let out = '';
  let cur = 0;
  for (const ch of s) {
    const cw = ch.codePointAt(0) > 0x2e00 ? 2 : 1;
    if (cur + cw > w - 1) { out += '…'; break; }
    out += ch;
    cur += cw;
  }
  return out;
}

function visibleWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) > 0x2e00 ? 2 : 1;
  return w;
}

function padRight(s, w) {
  return s + ' '.repeat(Math.max(0, w - visibleWidth(s)));
}
