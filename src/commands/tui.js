// src/commands/tui.js
// 实时多帐号仪表盘 (htop 风格)
//
// 设计 (v0.5):
//   - daemon 后台 round-robin 轮询每个账户 usage，写入 config.json
//   - TUI 只读 config.json，0 API 请求 → 无 IP 429 风险
//   - ↑↓ 移动选中行（反白显示）
//   - Enter 切换到当前选中帐号 (use)
//   - p     ping 当前选中帐号
//   - r     立即从 config.json 重新加载（瞬间，无网络）
//   - q     退出
//   - 每 5s 自动从本地缓存重绘 (拿 daemon 最新轮询数据)

import { loadConfig, getAccessToken } from '../config.js';
import { daemonStatus } from '../daemon.js';
import { isKeychainSupported, readKeychainRaw, parseClaudeCredentials } from '../keychain.js';
import { health as healthScore, shouldPrePing, needsSwitch, bestSwitchCandidate } from '../scheduler.js';
import useCommand from './use.js';
import { runPing } from './ping-cmd.js';

const REFRESH_INTERVAL_MS = 5_000; // 5s 重读 config.json，拿 daemon 最新轮询数据

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

  async function manualReload() {
    busy = true;
    status = '已从缓存重新加载（daemon 后台轮询负责数据更新）';
    await refreshLocal();
    busy = false;
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
    if (k === 'r') return manualReload();
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
    const N = configCache.accounts.length;
    const pollHint = daemonCache?.running && N > 0
      ? `${C.dim}usage 每 ${N}min 轮询一次${C.reset}`
      : `${C.dim}daemon 未运行，数据不刷新${C.reset}`;
    lines.push(`${C.cyan}${C.bold}▲ relay-claude${C.reset}    ${C.gray}${now}${C.reset}    ${pollHint}    Daemon: ${daemon}    ${N} accounts`);
    lines.push('');

    // 计算每个帐号的健康度（缓存到 a._health 供表格使用）
    for (const a of configCache.accounts) {
      a._health = Math.round(healthScore(a, configCache, nowMs));
    }
    const activeAcc = configCache.accounts.find(
      (a) => activeAccessToken && getAccessToken(a) === activeAccessToken,
    );
    const staggerMin =
      configCache.scheduler?.stagger_min ?? (N > 0 ? Math.round(300 / N) : 0);

    // 调度策略面板
    const nextAction = predictNextAction(configCache.accounts, activeAcc, configCache, nowMs);
    const prePingPct = Math.round((configCache.scheduler?.preping_usage_threshold ?? 0.5) * 100);
    lines.push(`${C.bold}${C.cyan}┌─ 调度策略 ${'─'.repeat(50)}${C.reset}`);
    lines.push(
      `${C.cyan}│${C.reset} 活跃: ${
        activeAcc ? `${C.bold}${activeAcc.name}${C.reset} (${activeAcc.credentials?.subscriptionType ?? '-'}) ← health ${activeAcc._health}` : '(无)'
      }`,
    );
    lines.push(`${C.cyan}│${C.reset} 下一动作: ${C.bold}${nextAction}${C.reset}`);
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
      { label: 'RESETS (5H / 7D)', width: 18 },
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
      const fhResets = fmtTimeUntil(a.last_usage?.five_hour?.resets_at);
      const sdResets = fmtTimeUntil(a.last_usage?.seven_day?.resets_at);
      const resets = padRight(`${fhResets} / ${sdResets}`, cols[5].width);
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

  // 启动：先本地渲染
  await refreshLocal();
  render();

  // 每 5s 重读 config.json — daemon 后台轮询 → config.json → TUI
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

function fmtNextPing(account, status, configCache, activeAcc, nowMs) {
  // 活跃帐号本身不需要 ping
  if (account === activeAcc) return '-';

  // 已激活备用：窗口在跑，不需要预 ping
  const u = account.last_usage?.five_hour;
  if (u?.resets_at && new Date(u.resets_at).getTime() > nowMs) {
    return '-';
  }
  // 已耗尽（5H 或 7D）：等待重置，无法预 ping
  if (u && (u.utilization ?? 0) >= 1.0) return '-';
  if ((account.last_usage?.seven_day?.utilization ?? 0) >= 1.0) return '-';

  // 未激活：预估下次预 ping 时间
  if (!activeAcc || !configCache || !status?.running) return '-';

  // 链式策略：如果已经有备用在跑，主账户不会预 ping 更多备用
  // 等切换到那个备用后才会接力，所以当前 active 期间这些待激活账户处于"等待"
  const runningBackups = configCache.accounts.filter(
    (a) =>
      a !== activeAcc &&
      a.last_usage?.five_hour?.resets_at &&
      new Date(a.last_usage.five_hour.resets_at).getTime() > nowMs &&
      (a.last_usage?.five_hour?.utilization ?? 0) < 1.0,
  ).length;
  if (runningBackups >= 1) return 'wait';

  // 选下一个被 ping 的目标（healthy 最高的待激活账户）
  const dormant = configCache.accounts
    .filter(
      (a) =>
        a !== activeAcc &&
        (a.last_usage?.seven_day?.utilization ?? 0) < 1.0 &&
        !(
          a.last_usage?.five_hour?.resets_at &&
          new Date(a.last_usage.five_hour.resets_at).getTime() > nowMs
        ) &&
        (a.last_usage?.five_hour?.utilization ?? 0) < 1.0,
    )
    .sort((a, b) => (b._health ?? 0) - (a._health ?? 0));
  if (dormant[0] !== account) return 'wait';

  // 是下一个目标 → 估算还要多久
  const N = configCache.accounts.length;
  const stagger =
    configCache.scheduler?.stagger_min ?? (N > 0 ? 300 / N : 75);
  const threshold = configCache.scheduler?.preping_usage_threshold ?? 0.5;

  // 基于 active 账户的窗口起点算 elapsed（而不是 daemon 启动时间）
  let windowStartMs;
  if (activeAcc.window_start) {
    windowStartMs = activeAcc.window_start;
  } else if (activeAcc.last_usage?.five_hour?.resets_at) {
    windowStartMs =
      new Date(activeAcc.last_usage.five_hour.resets_at).getTime() -
      5 * 3600 * 1000;
  } else {
    windowStartMs = nowMs;
  }
  const elapsedMin = Math.max(0, (nowMs - windowStartMs) / 60_000);

  // 时间维度：距离 stagger 还有多久
  const timeRemain = Math.max(0, stagger - elapsedMin);

  // 用量维度：按当前消耗速度估算到达 threshold 还要多久
  const activeUsage = activeAcc.last_usage?.five_hour?.utilization ?? 0;
  let usageRemain = Infinity;
  if (activeUsage >= threshold) {
    usageRemain = 0;
  } else if (activeUsage > 0 && elapsedMin > 1) {
    const rate = activeUsage / elapsedMin; // %/min
    usageRemain = (threshold - activeUsage) / rate;
  }

  const remain = Math.max(0, Math.round(Math.min(timeRemain, usageRemain)));
  return remain === 0 ? 'soon' : `ping@${remain}m`;
}

/**
 * 预测 daemon 下一个动作（用于调度面板"下一动作"行）。
 * 返回类似 "切换 → 备用3 (主力耗尽时立即)" 或 "预 PING → 备用2 (约 15min 后)"。
 */
function predictNextAction(accounts, activeAcc, cfg, nowMs) {
  // 没有活跃账户：daemon 重启或 Keychain 未识别，需要先切换
  if (!activeAcc) {
    const candidate = bestSwitchCandidate(accounts, null, cfg, nowMs);
    if (!candidate) return '无可用账户';
    return `${C.yellow}切换 → ${candidate.name}${C.reset}（无活跃账户，立即）`;
  }

  // 活跃账户失效：立即切换
  if (needsSwitch(activeAcc, cfg, nowMs)) {
    const candidate = bestSwitchCandidate(accounts, activeAcc, cfg, nowMs);
    if (!candidate) return `${C.red}所有账户耗尽${C.reset}（等最早重置）`;
    return `${C.yellow}切换 → ${candidate.name}${C.reset}（活跃失效，立即）`;
  }

  // 预 PING 检查
  const next = shouldPrePing(accounts, activeAcc, cfg, nowMs);
  if (next) {
    return `${C.cyan}预 PING → ${next.name}${C.reset}（条件已满足，下个调度周期）`;
  }

  // 计算"还要多久才会预 PING"
  const N = accounts.length;
  const stagger = cfg.scheduler?.stagger_min ?? (N > 0 ? 300 / N : 75);
  const threshold = cfg.scheduler?.preping_usage_threshold ?? 0.5;
  const activeUsage = activeAcc.last_usage?.five_hour?.utilization ?? 0;

  let windowStartMs;
  if (activeAcc.window_start) {
    windowStartMs = activeAcc.window_start;
  } else if (activeAcc.last_usage?.five_hour?.resets_at) {
    windowStartMs = new Date(activeAcc.last_usage.five_hour.resets_at).getTime() - 5 * 3600 * 1000;
  } else {
    windowStartMs = nowMs;
  }
  const elapsedMin = Math.max(0, (nowMs - windowStartMs) / 60_000);
  const timeRemain = Math.max(0, stagger - elapsedMin);

  // 已有备用在跑 → 链式策略
  const runningBackups = accounts.filter(
    (a) =>
      a !== activeAcc &&
      a.last_usage?.five_hour?.resets_at &&
      new Date(a.last_usage.five_hour.resets_at).getTime() > nowMs &&
      (a.last_usage?.five_hour?.utilization ?? 0) < 1.0,
  );
  if (runningBackups.length >= 1) {
    const next = runningBackups.sort((a, b) => (b._health ?? 0) - (a._health ?? 0))[0];
    return `${C.dim}等链式接力${C.reset}（${next.name} 已激活，活跃耗尽后切给它）`;
  }

  // 选下一个待激活目标
  const dormant = accounts
    .filter(
      (a) =>
        a !== activeAcc &&
        (a.last_usage?.seven_day?.utilization ?? 0) < 1.0 &&
        !(
          a.last_usage?.five_hour?.resets_at &&
          new Date(a.last_usage.five_hour.resets_at).getTime() > nowMs
        ),
    )
    .sort((a, b) => (b._health ?? 0) - (a._health ?? 0));
  if (dormant.length === 0) return `${C.dim}无可预 PING 的备用账户${C.reset}`;
  const target = dormant[0];

  // 用量维度预估
  let usageRemainMin = Infinity;
  if (activeUsage > 0 && elapsedMin > 1) {
    const rate = activeUsage / elapsedMin;
    usageRemainMin = Math.max(0, (threshold - activeUsage) / rate);
  }
  const remain = Math.round(Math.min(timeRemain, usageRemainMin));
  if (remain <= 0) return `${C.cyan}预 PING → ${target.name}${C.reset}（即将）`;
  const reason = timeRemain < usageRemainMin
    ? `${remain}min 后（时间到 stagger）`
    : `${remain}min 后（用量达 ${Math.round(threshold * 100)}%）`;
  return `${C.dim}预 PING → ${target.name}${C.reset}（${reason}）`;
}

function fmtStateLabel(account, isActive, nowMs) {
  if (isActive) return '🟢 活跃';
  if ((account.last_usage?.seven_day?.utilization ?? 0) >= 1.0) return '🔴 耗尽';
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
