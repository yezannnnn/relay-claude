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
import { health as healthScore } from '../scheduler.js';
import useCommand from './use.js';
import { runPing } from './ping-cmd.js';

const REFRESH_INTERVAL_MS = 10_000;
const API_REFRESH_INTERVAL_MS = 300_000; // 5 分钟一次，避免 Anthropic 限流

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

  let cursor = 0;            // 当前选中行索引
  let status = '';           // 底部状态消息（操作反馈）
  let busy = false;
  let apiRefreshing = false; // 防止 API 刷新并发
  let lastApiRefresh = null; // 上次 API 刷新时间
  let timer = null;
  let apiTimer = null;
  let quitting = false;
  let configCache = null;
  let daemonCache = null;
  let activeAccessToken = null;

  function quit() {
    if (quitting) return;
    quitting = true;
    if (timer) clearInterval(timer);
    if (apiTimer) clearInterval(apiTimer);
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

  async function refreshFromAPI(fromUser = false) {
    if (apiRefreshing) return;
    apiRefreshing = true;
    if (fromUser) busy = true;
    status = '正在刷新所有帐号 usage...';
    render();
    let config = await loadConfig();
    let okCount = 0;
    const failed = [];
    const accountList = config.accounts.filter((a) => a.credentials);
    for (let i = 0; i < accountList.length; i++) {
      const a = accountList[i];
      // 账户间隔 800ms，避免 Anthropic IP 限流（多账户共享同 IP 调用 usage）
      if (i > 0) await new Promise((r) => setTimeout(r, 800));
      try {
        const { usage, credentials } = await queryUsageWithRefresh(a.credentials);
        if (credentials.accessToken !== a.credentials.accessToken) {
          config = setCredentials(config, a.name, credentials);
        }
        config = setLastUsage(config, a.name, usage);
        okCount++;
      } catch (err) {
        failed.push({ name: a.name, reason: err?.message ?? String(err) });
      }
    }
    await saveConfig(config);
    lastApiRefresh = new Date();
    const timeStr = lastApiRefresh.toLocaleTimeString('zh-CN', { hour12: false });
    if (failed.length === 0) {
      status = `已刷新 ${timeStr} — ${okCount} OK`;
    } else {
      const failNames = failed.map((f) => f.name).join(', ');
      status = `已刷新 ${timeStr} — ${okCount} OK, ${failed.length} 失败: ${failNames}`;
    }
    apiRefreshing = false;
    if (fromUser) busy = false;
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
      const result = await runPing(target.name);
      if (result.error) {
        status = `❌ ping ${target.name}: ${result.error}`;
      } else if (result.success) {
        status = `✅ ping ${target.name} OK (${result.elapsed}ms)`;
      } else {
        // ping 失败但不杀 TUI，只显示原因
        let reason = `code=${result.code}`;
        if (result.timedOut) reason = 'timeout';
        else if (result.stderr) {
          const head = result.stderr.trim().split('\n')[0].slice(0, 80);
          reason = head || reason;
        } else if (result.stdout) {
          const head = result.stdout.trim().split('\n')[0].slice(0, 80);
          reason = head || reason;
        }
        status = `❌ ping ${target.name} 失败 (${result.elapsed}ms): ${reason}`;
      }
    } catch (err) {
      status = `❌ ping 异常: ${err?.message ?? err}`;
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
    if (k === 'r') return refreshFromAPI(true);
  });

  function render() {
    if (!configCache) return;
    const lines = [];

    // 标题行
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const nowMs = Date.now();
    const daemon = daemonCache?.running
      ? `${C.green}●${C.reset} 运行中 (uptime ${daemonCache.uptime ?? '-'})`
      : `${C.red}●${C.reset} 未运行`;
    const refreshTag = apiRefreshing
      ? `${C.yellow}⟳ 刷新中...${C.reset}`
      : lastApiRefresh
        ? `${C.dim}上次刷新: ${lastApiRefresh.toLocaleTimeString('zh-CN', { hour12: false })}${C.reset}`
        : `${C.dim}自动刷新: 5min${C.reset}`;
    lines.push(`${C.cyan}${C.bold}▲ relay-claude${C.reset}    ${C.gray}${now}${C.reset}    ${refreshTag}    Daemon: ${daemon}    ${configCache.accounts.length} accounts`);
    lines.push('');

    // 计算每个帐号的健康度（缓存到 a._health 供表格使用）
    for (const a of configCache.accounts) {
      a._health = Math.round(healthScore(a, configCache, nowMs));
    }
    const activeAcc = configCache.accounts.find(
      (a) => activeAccessToken && getAccessToken(a) === activeAccessToken,
    );
    const candidates = configCache.accounts
      .filter((a) => a !== activeAcc && a._health > 0)
      .sort((a, b) => b._health - a._health);
    const nextCandidate = candidates[0];

    const N = configCache.accounts.length;
    const staggerMin =
      configCache.scheduler?.stagger_min ?? (N > 0 ? Math.round(300 / N) : 0);

    // 调度策略面板
    lines.push(`${C.bold}${C.cyan}┌─ 调度策略 ${'─'.repeat(50)}${C.reset}`);
    lines.push(
      `${C.cyan}│${C.reset} 活跃: ${
        activeAcc ? `${C.bold}${activeAcc.name}${C.reset} (${activeAcc.credentials?.subscriptionType ?? '-'}) ← health ${activeAcc._health}` : '(无)'
      }`,
    );
    lines.push(
      `${C.cyan}│${C.reset} 下一切换候选: ${
        nextCandidate
          ? `${nextCandidate.name} (${nextCandidate.credentials?.subscriptionType ?? '-'}) ← health ${nextCandidate._health}`
          : '(无)'
      }`,
    );
    const prePingPct = Math.round((configCache.scheduler?.preping_usage_threshold ?? 0.5) * 100);
    lines.push(
      `${C.cyan}│${C.reset} 阈值: 切换=100%   预ping=${prePingPct}% 或 ${staggerMin}min   错峰间隔=${staggerMin}min (300 ÷ ${N})`,
    );
    lines.push(`${C.cyan}└${'─'.repeat(60)}${C.reset}`);
    lines.push('');

    // 表头
    const cols = [
      { label: 'NAME', width: 14 },
      { label: 'SUB', width: 8 },
      { label: '5H USAGE', width: 32 },
      { label: '7D', width: 6 },
      { label: 'NEXT', width: 10 },
      { label: 'RESETS', width: 10 },
      { label: 'H分', width: 8 },
      { label: '状态', width: 14 },
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
      const next = padRight(fmtNextPing(a, daemonCache, configCache, activeAcc, nowMs), cols[4].width);
      const resets = padRight(fmtTimeUntil(a.last_usage?.five_hour?.resets_at), cols[5].width);
      const hScore = padRight(String(a._health ?? 0), cols[6].width);
      const stateLabel = padRight(fmtStateLabel(a, isActive, nowMs), cols[7].width);

      const row = `${marker} ${name} ${sub} ${usageBar} ${sevenD} ${next} ${resets} ${hScore} ${stateLabel}`;
      if (i === cursor) {
        lines.push(`${C.inv}${row}${C.reset}`);
      } else {
        lines.push(row);
      }
      // 邮箱副行（dim，仅在有 email 时显示）
      const email = a.credentials?.email;
      if (email) {
        const emailLine = `  ${C.dim}${C.gray}${email}${C.reset}`;
        lines.push(i === cursor ? `${C.inv}  ${email}${C.reset}` : emailLine);
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
      `${C.bold}r${C.reset} 立即刷新`,
      `${C.bold}q${C.reset} 退出`,
    ];
    lines.push(`${C.dim}  ${helpItems.join('   ')}${C.reset}`);

    // 输出：光标回顶覆盖 + 每行末尾 \x1b[K 清到行尾 + 屏幕末尾 \x1b[J 清残留
    process.stdout.write('\x1b[H');
    process.stdout.write(lines.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  }

  // 启动：先本地渲染，然后立刻做一次 API 刷新拿最新数据
  await refreshLocal();
  render();
  refreshFromAPI(); // 首次启动不 await，后台刷新

  timer = setInterval(async () => {
    if (busy) return;
    await refreshLocal();
    render();
  }, REFRESH_INTERVAL_MS);

  // 每 60s 自动刷新所有帐号 usage（不阻塞键盘）
  apiTimer = setInterval(async () => {
    if (busy || apiRefreshing || quitting) return;
    await refreshFromAPI();
  }, API_REFRESH_INTERVAL_MS);

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

function fmtNextPing(account, status, configCache, activeAcc, nowMs) {
  // 活跃帐号本身不需要 ping
  if (account === activeAcc) return '-';

  // 已激活备用：窗口在跑，不需要预 ping
  const u = account.last_usage?.five_hour;
  if (u?.resets_at && new Date(u.resets_at).getTime() > nowMs) {
    return '-';
  }

  // 未激活：预估下次预 ping 时间
  if (!activeAcc || !configCache || !status?.running) return '-';

  const N = configCache.accounts.length;
  const stagger =
    configCache.scheduler?.stagger_min ?? (N > 0 ? 300 / N : 75);

  // 未激活帐号按健康度排序后的索引
  const dormant = configCache.accounts
    .filter(
      (a) => a !== activeAcc && !a.last_usage?.five_hour?.resets_at,
    )
    .sort((a, b) => (b._health ?? 0) - (a._health ?? 0));
  const idx = dormant.indexOf(account);
  if (idx < 0) return '-';

  // 已激活备用数（不算活跃帐号）
  const running = configCache.accounts.filter(
    (a) =>
      a !== activeAcc &&
      a.last_usage?.five_hour?.resets_at &&
      new Date(a.last_usage.five_hour.resets_at).getTime() > nowMs &&
      (a.last_usage?.five_hour?.utilization ?? 0) < 1.0,
  ).length;

  const targetIdx = idx + running;
  const targetTimeMin = (targetIdx + 1) * stagger;

  const startMs = status?.startedAt
    ? new Date(status.startedAt).getTime()
    : nowMs;
  const elapsedMin = Math.max(0, (nowMs - startMs) / 60_000);
  const remainMin = Math.max(0, Math.round(targetTimeMin - elapsedMin));
  return `ping@${remainMin}m`;
}

function fmtStateLabel(account, isActive, nowMs) {
  if (isActive) return '🟢 活跃';
  const u = account.last_usage?.five_hour;
  if (u && u.utilization >= 1.0) return '🔴 耗尽';
  const resetsAtMs = u?.resets_at ? new Date(u.resets_at).getTime() : null;
  if (resetsAtMs && resetsAtMs > nowMs) return '🔵 备用';
  return '⚪ 待激活';
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
