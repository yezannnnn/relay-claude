// `interval-claude list` — 列出所有帐号与状态
//
// 输出列: name | last_ping | remaining (min) | status
//
// status 取值:
//   - never    : 从未 ping 过
//   - active   : 剩余 >= 60 min
//   - expiring : 剩余 < 60 min
//   - expired  : 剩余 = 0

import { loadConfig, getConfigPath } from '../config.js';
import { loadState } from '../state.js';
import { estimatedRemainingMinutes } from '../scheduler.js';

function formatTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function statusOf(remaining) {
  if (remaining === null) return 'never';
  if (remaining === 0) return 'expired';
  if (remaining < 60) return 'expiring';
  return 'active';
}

function padCell(s, width) {
  s = String(s);
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

export default async function listCommand() {
  const config = await loadConfig();
  const accounts = config.accounts ?? [];

  if (accounts.length === 0) {
    console.log('未配置任何帐号。运行 `interval-claude init` 开始配置。');
    console.log(`配置文件位置: ${getConfigPath()}`);
    return;
  }

  const state = await loadState();
  const now = new Date();

  const rows = accounts.map((a) => {
    const lastIso = state.last_pings?.[a.name] ?? null;
    const remaining = estimatedRemainingMinutes(a, state, now);
    return {
      name: a.name,
      offset: a.offset_minutes ?? 0,
      lastPing: formatTime(lastIso),
      remaining: remaining === null ? '-' : String(remaining),
      status: statusOf(remaining),
    };
  });

  // 计算列宽
  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    offset: Math.max(6, ...rows.map((r) => String(r.offset).length)),
    lastPing: Math.max(19, ...rows.map((r) => r.lastPing.length)),
    remaining: Math.max(9, ...rows.map((r) => r.remaining.length)),
    status: Math.max(8, ...rows.map((r) => r.status.length)),
  };

  const header =
    padCell('NAME', widths.name) +
    '  ' +
    padCell('OFFSET', widths.offset) +
    '  ' +
    padCell('LAST PING', widths.lastPing) +
    '  ' +
    padCell('REMAIN(m)', widths.remaining) +
    '  ' +
    padCell('STATUS', widths.status);
  const separator = '-'.repeat(header.length);
  console.log(header);
  console.log(separator);
  for (const r of rows) {
    console.log(
      padCell(r.name, widths.name) +
        '  ' +
        padCell(r.offset, widths.offset) +
        '  ' +
        padCell(r.lastPing, widths.lastPing) +
        '  ' +
        padCell(r.remaining, widths.remaining) +
        '  ' +
        padCell(r.status, widths.status)
    );
  }
  console.log('');
  console.log(`interval_minutes=${config.interval_minutes}  共 ${accounts.length} 个帐号`);
}
