// 守护进程主循环 + 启停控制
//
// 三个角色:
//   - runDaemon: 实际的主循环逻辑（被 daemon-worker.js 调用）
//   - startDaemon: 父进程 fork 一个后台子进程来跑 runDaemon
//   - stopDaemon: 向后台子进程发 SIGTERM，5s 后仍存活则 SIGKILL
//   - daemonStatus: 读 state.json 查当前是否在跑
//
// 关键设计:
//   - runDaemon 接受 options 注入（pingFn/nowFn/logFn/shouldStop），便于测试
//   - 每轮循环重读 config + state，支持运行时修改配置
//   - 异常被吞掉到 per-account 级别，单帐号失败不影响其他帐号
//   - sleep 可中断 — shouldStop=true 时秒级响应，不等满 60s

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadConfig,
  saveConfig,
  setCredentials,
  setLastUsage,
  updateConfig,
} from './config.js';
import {
  loadState,
  recordPing,
  setDaemonPid,
  clearDaemonPid,
  isDaemonAlive,
} from './state.js';
import { dueAccounts, schedule, ACTION_PING, ACTION_USE, health } from './scheduler.js';
import { pingWithRetry } from './pinger.js';
import { appendLog, toCST } from './logger.js';
import { queryUsageWithRefresh, refreshAccessToken, isExpiringSoon } from './oauth.js';
import { dispatchNotification } from './notifier.js';
import {
  isKeychainSupported,
  readKeychainRaw,
  writeKeychainRaw,
  parseClaudeCredentials,
  serializeCredentials,
} from './keychain.js';

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 200;

/**
 * 可中断 sleep — 每 step 毫秒检查一次 shouldStop。
 * 这样停止信号到来后 1s 内主循环就能退出。
 */
async function interruptibleSleep(ms, shouldStop) {
  const step = 1000;
  let elapsed = 0;
  while (elapsed < ms && !shouldStop()) {
    const chunk = Math.min(step, ms - elapsed);
    await new Promise((r) => setTimeout(r, chunk));
    elapsed += chunk;
  }
}

/**
 * 在 ping 成功后调用：查 usage、自动续期临期 token，回写 config。
 * 此操作失败不影响 ping 主流程（v0.1 legacy_token 没法查 usage，直接跳过）。
 */
async function refreshUsageAndToken(accountName, logFn, pingedAt = Date.now()) {
  // 先读一次拿到当前帐号引用
  let initialConfig;
  try {
    initialConfig = await loadConfig();
  } catch (err) {
    logFn(`usage refresh: 加载 config 失败 ${err?.message ?? err}`);
    return;
  }
  const account = initialConfig.accounts.find((a) => a.name === accountName);
  if (!account?.credentials) return;
  try {
    const { usage, credentials } = await queryUsageWithRefresh(account.credentials);
    // 原子写入：避免被其他写入路径覆盖
    await updateConfig((cfg) => {
      let next = setLastUsage(cfg, accountName, usage);
      const existing = next.accounts.find((a) => a.name === accountName);
      if (existing?.credentials?.accessToken !== credentials.accessToken) {
        next = setCredentials(next, accountName, credentials);
      }
      return next;
    });
    if (credentials.accessToken !== account.credentials.accessToken) {
      logFn(`token refreshed for ${accountName}`);
    }
  } catch (err) {
    logFn(`usage refresh failed for ${accountName}: ${err?.message ?? err}`);
    // 兜底：usage 查询失败（如 429 限流）也要标记窗口已激活，避免下次周期重复 PING
    // 写入一个预估窗口，并加 isPlaceholder 标记 — 调度器看到此标记会降低健康度，
    // 防止"假满血"账户被优先选作切换目标导致震荡
    try {
      await updateConfig((cfg) => {
        const existing = cfg.accounts.find((a) => a.name === accountName);
        // 已有真实 resets_at 就不要覆盖
        if (existing?.last_usage?.five_hour?.resets_at &&
            !existing.last_usage.five_hour.isPlaceholder) {
          return cfg;
        }
        const FULL_WINDOW_MS = 5 * 60 * 60 * 1000;
        const placeholder = {
          five_hour: {
            utilization: 0,
            resets_at: new Date(pingedAt + FULL_WINDOW_MS).toISOString(),
            isPlaceholder: true,
          },
        };
        return setLastUsage(cfg, accountName, placeholder);
      });
      logFn(`placeholder window set for ${accountName} (avoid re-ping loop)`);
    } catch (e) {
      logFn(`failed to set placeholder for ${accountName}: ${e?.message ?? e}`);
    }
  }
}

/**
 * 守护进程主循环。
 *
 * @param {Object} options
 * @param {number} [options.checkIntervalMs=60000] - 两次扫描间隔
 * @param {Function} [options.logFn] - 日志函数 (message: string) => void
 * @param {Function} [options.pingFn] - ping 函数 (account, prompt) => Promise<{success, ...}>
 *                                       与 pingWithRetry 兼容（返回 {success, ...}）
 * @param {Function} [options.nowFn] - 时间提供函数 () => Date
 * @param {Function} [options.shouldStop] - 终止信号 () => boolean，true 时退出循环
 * @returns {Promise<void>}
 */
export async function runDaemon(options = {}) {
  const checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const logFn = options.logFn ?? ((msg) => appendLog(msg));
  const pingFn = options.pingFn ?? pingWithRetry;
  const nowFn = options.nowFn ?? (() => new Date());
  const shouldStop = options.shouldStop ?? (() => false);
  // 测试可注入假 Keychain，避免读真实系统 Keychain 导致测试 hang
  const keychainSupportedFn = options.keychainSupportedFn ?? isKeychainSupported;
  const readKeychainRawFn = options.readKeychainRawFn ?? readKeychainRaw;
  // 测试可注入假 usage 查询，避免真实 HTTP 调用
  const queryUsageWithRefreshFn = options.queryUsageWithRefreshFn ?? queryUsageWithRefresh;
  // 测试可注入假 use 切换，避免真实 Keychain 写入
  const useAccountFn = options.useAccountFn ?? ((name) => performUseFromDaemon(name));

  logFn('daemon: 主循环启动 (v0.3 动态调度)');

  // 内存状态：避免重复通知"全满"
  let allExhaustedNotified = false;
  // 内存状态：跟踪 limit_reached 标记（按帐号名）
  const limitReachedAt = new Map();
  // refresh 失败的指数退避状态（按帐号名）
  //   { nextAttemptAt: 下次允许尝试的时间戳, attempts: 已失败次数 }
  const refreshBackoff = new Map();
  // 🛡️ PING 防滥用：记录每个账户最近一次 PING 时间戳（按帐号名）
  // 同一账户在 MIN_PING_INTERVAL_MS 内不允许重复 PING，无视调度算法
  // 这是兜底保护，防止任何 bug 导致额度被反复 PING 消耗
  const lastPingedAt = new Map();
  const MIN_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟硬隔离

  // v0.5 新增：daemon 后台轮询所有账户 usage（round-robin）。
  // 每个主循环只查 1 个账户 → N 账户 N 分钟（60s × N）全部刷新一遍。
  // TUI 完全只读 config.json，不再发 API 请求 → 彻底消除 IP 429。
  let usagePollCursor = 0;

  while (!shouldStop()) {
    let config;
    try {
      config = await loadConfig();
    } catch (err) {
      logFn(`daemon: load config 失败: ${err?.message ?? err}`);
      await interruptibleSleep(checkIntervalMs, shouldStop);
      continue;
    }

    if (config.scheduler?.enabled === false) {
      logFn('daemon: scheduler.enabled=false, 跳过');
      await interruptibleSleep(checkIntervalMs, shouldStop);
      continue;
    }

    // 把 limit_reached 标记合并到帐号对象，供 needsSwitch 用
    for (const a of config.accounts) {
      const ts = limitReachedAt.get(a.name);
      if (ts) a.limit_reached_at = ts;
    }

    // v0.3 新增：主动续期临期 token（不依赖 ping 触发）
    // 防止用户离开期间 token 过期导致第二天要重新 /login
    // v0.4 改进:
    //   - 续期成功后，如果该帐号正是 Keychain active，同步写回 Keychain
    //   - 失败时指数退避：1min → 2min → 4min → 8min → 16min → 30min(封顶)
    //     避免连续 invalid_grant 时每分钟打废 Anthropic API，触发 IP 限流
    //   - 用原子 updateConfig 避免和其他写入路径竞争
    const nowForRefresh = Date.now();
    for (const a of config.accounts) {
      if (!a.credentials) continue;
      if (!isExpiringSoon(a.credentials, 30 * 60 * 1000)) continue; // 30 min 预警

      // 退避检查
      const backoff = refreshBackoff.get(a.name);
      if (backoff && nowForRefresh < backoff.nextAttemptAt) continue;

      const tsIso = toCST(nowFn());
      const oldAccessToken = a.credentials.accessToken;
      logFn(`[${tsIso}] proactive refresh: ${a.name} (expiring in <30min)`);
      try {
        const newCreds = await refreshAccessToken(a.credentials);
        // 原子写入 config，避免被 TUI / list / use 覆盖
        await updateConfig((cfg) => setCredentials(cfg, a.name, newCreds));
        a.credentials = newCreds;
        refreshBackoff.delete(a.name); // 成功 → 清退避
        logFn(`[${tsIso}] proactive refresh ${a.name}: OK (next exp ${toCST(new Date(newCreds.expiresAt))})`);

        // 同步写 Keychain（如果该账户正是 active）
        if (keychainSupportedFn()) {
          try {
            const currentRaw = readKeychainRawFn();
            if (currentRaw) {
              const keychainCreds = parseClaudeCredentials(currentRaw);
              if (keychainCreds.accessToken === oldAccessToken) {
                const newRaw = serializeCredentials(newCreds, currentRaw);
                writeKeychainRaw(newRaw);
                logFn(`[${tsIso}] keychain synced for ${a.name} (active)`);
              }
            }
          } catch (e) {
            logFn(`[${tsIso}] keychain sync failed for ${a.name}: ${e?.message ?? e}`);
          }
        }
      } catch (err) {
        // 指数退避：1min × 2^attempts，封顶 30min
        const prev = refreshBackoff.get(a.name) ?? { attempts: 0 };
        const attempts = prev.attempts + 1;
        const delayMin = Math.min(30, Math.pow(2, attempts - 1));
        refreshBackoff.set(a.name, {
          nextAttemptAt: nowForRefresh + delayMin * 60_000,
          attempts,
        });
        logFn(`[${tsIso}] proactive refresh ${a.name}: FAIL ${err?.message ?? err} (next retry in ${delayMin}min)`);
      }
    }

    // v0.5: round-robin 轮询一个账户的 usage（每周期只查 1 个，避免 429）
    // 跳过：无 credentials / 7D 已满（不再变化）
    const pollable = config.accounts.filter(
      (a) => a.credentials && (a.last_usage?.seven_day?.utilization ?? 0) < 1.0,
    );
    if (pollable.length > 0) {
      const target = pollable[usagePollCursor % pollable.length];
      usagePollCursor = (usagePollCursor + 1) % pollable.length;
      const tsIso = toCST(nowFn());
      try {
        const { usage, credentials } = await queryUsageWithRefreshFn(target.credentials);
        await updateConfig((cfg) => {
          let next = setLastUsage(cfg, target.name, usage);
          const existing = next.accounts.find((a) => a.name === target.name);
          if (existing?.credentials?.accessToken !== credentials.accessToken) {
            next = setCredentials(next, target.name, credentials);
          }
          return next;
        });
        const fhPct = usage?.five_hour?.utilization != null
          ? Math.round(usage.five_hour.utilization * 100) : '?';
        const sdPct = usage?.seven_day?.utilization != null
          ? Math.round(usage.seven_day.utilization * 100) : '?';
        logFn(`[${tsIso}] usage poll ${target.name}: 5H=${fhPct}% 7D=${sdPct}%`);
      } catch (err) {
        const msg = err?.message ?? String(err);
        // 429 / 网络错误：保留旧 usage 数据，下次轮询再试
        logFn(`[${tsIso}] usage poll ${target.name}: ${msg.slice(0, 100)}`);
      }
    }

    // 识别当前活跃帐号（通过 Keychain）
    // 如果 Keychain 里的 token 不属于任何已配置帐号，说明用户手动切换到了
    // config 外的帐号（如自己的帐号），此时 pause 调度，避免强行覆盖。
    let active = null;
    let keychainUnknown = false;
    if (keychainSupportedFn()) {
      try {
        const raw = readKeychainRawFn();
        if (raw) {
          const creds = parseClaudeCredentials(raw);
          // 先用 accessToken 精确匹配
          active = config.accounts.find(
            (a) => a.credentials?.accessToken === creds.accessToken,
          );
          // accessToken 不匹配时退回 refreshToken 匹配：
          // 场景：proactive refresh 更新了 config.json 的 accessToken，
          // 但 Keychain 同步失败 → Keychain 还是旧 token，
          // refreshToken 不变可以识别出是同一个 relay 帐号。
          if (!active && creds.refreshToken) {
            active = config.accounts.find(
              (a) => a.credentials?.refreshToken === creds.refreshToken,
            );
            if (active) {
              // Keychain 有过期 accessToken → 立即同步为最新
              try {
                const newRaw = serializeCredentials(active.credentials, raw);
                writeKeychainRaw(newRaw);
                const ts = toCST(nowFn());
                logFn(`[${ts}] daemon: Keychain stale for ${active.name}, synced accessToken`);
              } catch (e) {
                const ts = toCST(nowFn());
                logFn(`[${ts}] daemon: Keychain sync failed for ${active.name}: ${e?.message ?? e}`);
              }
            }
          }
          if (!active && creds.accessToken) {
            keychainUnknown = true;
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Keychain 是外部未知帐号 → 暂停调度，不抢覆盖
    if (keychainUnknown) {
      const tsIso = toCST(nowFn());
      logFn(`[${tsIso}] daemon: Keychain 属于未知帐号，暂停调度（避免覆盖手动登录）`);
      await interruptibleSleep(checkIntervalMs, shouldStop);
      continue;
    }

    const nowMs = nowFn().getTime();
    let actions;
    try {
      actions = schedule(config.accounts, active, config, nowMs);
    } catch (err) {
      logFn(`daemon: schedule() 失败: ${err?.message ?? err}`);
      await interruptibleSleep(checkIntervalMs, shouldStop);
      continue;
    }

    if (actions.length === 0) {
      // 检测全满状态
      const hasAnyHealthy = config.accounts.some(
        (a) => health(a, config, nowMs) > 0,
      );
      if (!hasAnyHealthy && !allExhaustedNotified) {
        const earliest = findEarliestReset(config.accounts, nowMs);
        const msg = earliest
          ? `所有帐号耗尽 — 最早重置: ${earliest.name} (${earliest.remainingMin}m 后)`
          : '所有帐号耗尽且无重置时间信息';
        logFn(`daemon: ${msg}`);
        if (config.scheduler?.notify !== false) {
          await dispatchNotification({
            title: 'relay-claude',
            subtitle: '⚠️ 所有帐号耗尽',
            message: msg,
          });
        }
        allExhaustedNotified = true;
      }
      await interruptibleSleep(checkIntervalMs, shouldStop);
      continue;
    }

    // 是否纯预 ping（没跟着 USE）— 用于决定要不要发"已激活备用"通知
    const isStandalonePing = actions.length === 1 && actions[0].type === ACTION_PING;

    // 执行动作
    for (let i = 0; i < actions.length; i++) {
      if (shouldStop()) break;
      const act = actions[i];
      const target = act.account;
      const tsIso = toCST(nowFn());
      const h = Math.round(health(target, config, nowMs));

      if (act.type === ACTION_PING) {
        // 硬隔离：同一账户 10 分钟内不允许重复 PING
        const lastPing = lastPingedAt.get(target.name);
        if (lastPing && nowFn().getTime() - lastPing < MIN_PING_INTERVAL_MS) {
          logFn(`[${tsIso}] PING ${target.name}: 跳过（距上次 PING 不足 10min）`);
          continue;
        }
        logFn(`[${tsIso}] schedule: PING ${target.name} (health=${h})`);
        try {
          const result = await pingFn(target, config.ping_prompt);
          if (result?.success) {
            const pingedAtMs = nowFn().getTime();
            lastPingedAt.set(target.name, pingedAtMs);
            await recordPing(target.name, new Date(pingedAtMs).toISOString());
            limitReachedAt.delete(target.name);
            logFn(`[${tsIso}] PING ${target.name}: OK`);
            await refreshUsageAndToken(target.name, logFn, pingedAtMs);
            allExhaustedNotified = false;

            // 错峰预 ping 才发通知（同组里跟着 USE 的 PING 不发，避免双通知）
            if (isStandalonePing && config.scheduler?.notify !== false) {
              const reason = describePrePingReason(active, config, nowMs);
              await dispatchNotification({
                title: 'relay-claude',
                subtitle: '已预激活备用帐号',
                message: `${target.name} 5h 窗口已开启${reason ? ` (${reason})` : ''}`,
              });
            }
          } else if (result?.limitReached) {
            limitReachedAt.set(target.name, nowMs);
            logFn(`[${tsIso}] PING ${target.name}: LIMIT_REACHED`);
          } else {
            const detail = result?.stderr || result?.lastResult?.stderr || result?.code || 'unknown';
            logFn(`[${tsIso}] PING ${target.name}: FAIL (${String(detail).trim()})`);
          }
        } catch (err) {
          logFn(`[${tsIso}] PING ${target.name}: ERROR ${err?.message ?? err}`);
        }
      } else if (act.type === ACTION_USE) {
        logFn(`[${tsIso}] schedule: USE ${target.name} (health=${h})`);
        try {
          await useAccountFn(target.name);
          if (config.scheduler?.notify !== false) {
            const fromName = active?.name ?? '上一个帐号';
            const targetUsage = target.last_usage?.five_hour;
            const usagePct = targetUsage?.utilization != null
              ? `${Math.round(targetUsage.utilization * 100)}%`
              : '未知';
            await dispatchNotification({
              title: 'relay-claude · 已切换帐号',
              subtitle: `${fromName} → ${target.name}`,
              message: `当前编程将使用 ${target.name} 额度（已用 ${usagePct}）`,
            });
          }
          allExhaustedNotified = false;
        } catch (err) {
          logFn(`[${tsIso}] USE ${target.name} 失败: ${err?.message ?? err}`);
        }
      }
    }

    if (shouldStop()) break;
    await interruptibleSleep(checkIntervalMs, shouldStop);
  }

  logFn('daemon: 主循环退出');
}

/** 推断预 ping 的触发原因（时间到 / 用量到），用于通知文案 */
function describePrePingReason(active, config, nowMs) {
  if (!active) return '';
  const N = config.accounts?.length ?? 0;
  if (N <= 1) return '';
  const stagger = config.scheduler?.stagger_min ?? Math.round(300 / N);
  const threshold = config.scheduler?.preping_usage_threshold ?? 0.5;

  let windowStartMs;
  if (active.window_start) {
    windowStartMs = active.window_start;
  } else if (active.last_usage?.five_hour?.resets_at) {
    windowStartMs =
      new Date(active.last_usage.five_hour.resets_at).getTime() - 300 * 60_000;
  } else {
    windowStartMs = nowMs;
  }
  const elapsedMin = Math.round((nowMs - windowStartMs) / 60_000);
  const usage = active.last_usage?.five_hour?.utilization ?? 0;
  const usagePct = Math.round(usage * 100);
  const thresholdPct = Math.round(threshold * 100);

  // 哪个条件先满足，就归因到那个
  const timeReached = elapsedMin >= stagger;
  const usageReached = usage >= threshold;
  if (timeReached && !usageReached) {
    return `${active.name} 已运行 ${elapsedMin}min，达到错峰间隔`;
  }
  if (usageReached && !timeReached) {
    return `${active.name} 用量 ${usagePct}% ≥ ${thresholdPct}%`;
  }
  if (timeReached && usageReached) {
    return `${active.name} 用量 ${usagePct}% / 已跑 ${elapsedMin}min`;
  }
  return '';
}

/** 找最早重置的帐号 */
function findEarliestReset(accounts, nowMs) {
  let best = null;
  for (const a of accounts) {
    const ts = a.last_usage?.five_hour?.resets_at;
    if (!ts) continue;
    const remainMin = (new Date(ts).getTime() - nowMs) / 60_000;
    if (remainMin <= 0) continue;
    if (!best || remainMin < best.remainingMin) {
      best = { name: a.name, remainingMin: Math.round(remainMin) };
    }
  }
  return best;
}

/** daemon 内切换帐号 — 调 useAccount（抛错）而非 CLI 入口（process.exit） */
async function performUseFromDaemon(name) {
  // 用 dynamic import 避免循环依赖
  const useModule = await import('./commands/use.js');
  await useModule.useAccount(name);
}

/**
 * 启动守护进程 — 用 spawn detached 启动 daemon-worker.js
 *
 * 流程:
 *   1. 已有存活的 daemon → 返回 {alreadyRunning: true, pid}
 *   2. spawn daemon-worker.js 作为 detached 子进程
 *   3. unref() 让父进程可独立退出
 *   4. PID 由 daemon-worker 自己写到 state（这里只是回填以便立即查询）
 *
 * @returns {Promise<{pid: number, started: boolean, alreadyRunning: boolean}>}
 */
export async function startDaemon() {
  if (await isDaemonAlive()) {
    const state = await loadState();
    return {
      pid: state.daemon_pid,
      started: false,
      alreadyRunning: true,
    };
  }

  // 定位 daemon-worker.js（同目录）
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(here, 'daemon-worker.js');

  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
    cwd: os.homedir(),
  });

  // 让父进程能独立退出
  child.unref();

  const pid = child.pid;
  // 子进程内部会调用 setDaemonPid，但为了 startDaemon 返回后立刻查询能拿到 pid，
  // 这里先回填一次。子进程跑起来后的 setDaemonPid 会覆盖（同 pid，无影响）。
  await setDaemonPid(pid);

  return {
    pid,
    started: true,
    alreadyRunning: false,
  };
}

/**
 * 停止守护进程。
 *   - 读 state.daemon_pid
 *   - SIGTERM → 等 5s
 *   - 仍存活 → SIGKILL
 *   - 最后清空 state.daemon_pid
 *
 * @returns {Promise<{stopped: boolean, wasRunning: boolean}>}
 */
export async function stopDaemon() {
  const state = await loadState();
  const pid = state.daemon_pid;

  if (!pid || !(await isDaemonAlive())) {
    // pid 不存在或进程已挂 — 清掉残留状态
    if (pid) await clearDaemonPid();
    return { stopped: false, wasRunning: false };
  }

  // SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      // ESRCH = 进程已经没了，无所谓；其他错误才上报
      // 但我们依然继续清理 state
    }
  }

  // 轮询等待最多 STOP_GRACE_MS
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!(await pidAlive(pid))) {
      await clearDaemonPid();
      return { stopped: true, wasRunning: true };
    }
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }

  // 仍存活 → SIGKILL
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 忽略
  }

  // 给 OS 一点回收时间
  await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  await clearDaemonPid();
  return { stopped: true, wasRunning: true };
}

/**
 * 查询守护进程状态。
 *
 * @returns {Promise<{running: boolean, pid: number|null, startedAt: string|null, uptime: string|null}>}
 */
export async function daemonStatus() {
  const state = await loadState();
  const running = await isDaemonAlive();
  return {
    running,
    pid: running ? state.daemon_pid : null,
    startedAt: running ? state.started_at : null,
    uptime: running ? formatUptime(state.started_at) : null,
  };
}

/** 内部：检测任意 pid 是否存活（不依赖 state） */
async function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true; // 存在但无权限
    return false;
  }
}

/** 内部：把 startedAt 格式化为「Xh Ym」 */
function formatUptime(startedAt) {
  if (!startedAt) return null;
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedMs)) return null;
  const elapsedMs = Date.now() - startedMs;
  if (elapsedMs < 0) return '0m';
  const totalMin = Math.floor(elapsedMs / 60000);
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
