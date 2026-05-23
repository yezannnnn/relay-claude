// `interval-claude watch` — 实时 ASCII 仪表盘，每 2 秒刷新
//
// 用 ANSI 控制序列清屏（\x1b[2J\x1b[H）。Ctrl+C 退出。
//
// 圆点含义:
//   🟢 active   剩余 >= 60min
//   🟡 expiring 剩余 < 60min
//   🔴 expired  剩余 = 0
//   ⚪ never    未 ping 过

import { loadConfig } from '../config.js';
import { loadState } from '../state.js';
import { daemonStatus } from '../daemon.js';
import { estimatedRemainingMinutes } from '../scheduler.js';

const REFRESH_MS = 2000;
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function formatTimeHMS(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatRemaining(minutes) {
  if (minutes === null || minutes === undefined) return null;
  if (minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function dotForRemaining(remaining) {
  if (remaining === null) return '⚪';
  if (remaining === 0) return '🔴';
  if (remaining < 60) return '🟡';
  return '🟢';
}

// 中文/emoji 在终端占 2 列，估算可见宽度
function visibleWidth(s) {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0x1100 && (
      code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    )) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padRight(s, width) {
  const cur = visibleWidth(s);
  if (cur >= width) return s;
  return s + ' '.repeat(width - cur);
}

async function renderFrame() {
  const config = await loadConfig();
  const accounts = config.accounts ?? [];
  const state = await loadState();
  const status = await daemonStatus();
  const now = new Date();

  // 计算每帐号显示行
  const lines = [];

  if (accounts.length === 0) {
    lines.push('未配置任何帐号 — 运行 interval-claude init 开始');
  } else {
    // 每行: "name  🟢 last ping HH:MM:SS  剩余 4h12m"
    const nameWidth = Math.max(8, ...accounts.map((a) => a.name.length));
    for (const a of accounts) {
      const lastIso = state.last_pings?.[a.name] ?? null;
      const remaining = estimatedRemainingMinutes(a, state, now);
      const dot = dotForRemaining(remaining);
      const ts = formatTimeHMS(lastIso);
      const lastPart = ts ? `last ping ${ts}` : '未 ping';
      const remainPart =
        remaining === null ? '' : `剩余 ${formatRemaining(remaining)}`;
      lines.push(
        `${padRight(a.name, nameWidth)}  ${dot} ${padRight(lastPart, 20)}${remainPart}`
      );
    }
  }

  // 计算 header
  const header = status.running
    ? `intervalClaude · 守护进程运行中（uptime ${status.uptime ?? '?'}）`
    : 'intervalClaude · 守护进程未运行 — 运行 interval-claude start 启动';

  // 决定外框宽度
  const contentWidth = Math.max(
    visibleWidth(header) + 4,
    ...lines.map((l) => visibleWidth(l) + 4),
    50
  );

  const top = '┌─ ' + header + ' ' + '─'.repeat(Math.max(0, contentWidth - visibleWidth(header) - 4)) + '┐';
  const bottom = '└' + '─'.repeat(contentWidth - 2) + '┘';
  const wrapped = lines.map((l) => '│ ' + padRight(l, contentWidth - 4) + ' │');

  const tsNow = formatTimeHMS(now.toISOString());
  const out =
    CLEAR_SCREEN +
    top +
    '\n' +
    wrapped.join('\n') +
    '\n' +
    bottom +
    '\n' +
    `刷新于 ${tsNow}  ·  按 Ctrl+C 退出\n`;

  process.stdout.write(out);
}

export default async function watchCommand() {
  let running = true;
  process.stdout.write(HIDE_CURSOR);

  const cleanup = () => {
    if (!running) return;
    running = false;
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write('\n');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // 立刻渲染一次，然后进入循环
  while (running) {
    try {
      await renderFrame();
    } catch (err) {
      process.stdout.write(CLEAR_SCREEN);
      process.stdout.write(`watch 错误: ${err.message}\n`);
    }
    await new Promise((r) => setTimeout(r, REFRESH_MS));
  }
}
