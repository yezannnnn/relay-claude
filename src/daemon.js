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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, saveConfig, setCredentials, setLastUsage } from './config.js';
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
import { isKeychainSupported, readKeychainRaw, parseClaudeCredentials } from './keychain.js';

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
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    logFn(`usage refresh: 加载 config 失败 ${err?.message ?? err}`);
    return;
  }
  const account = config.accounts.find((a) => a.name === accountName);
  if (!account?.credentials) return;
  try {
    const { usage, credentials } = await queryUsageWithRefresh(account.credentials);
    config = setLastUsage(config, accountName, usage);
    if (credentials.accessToken !== account.credentials.accessToken) {
      config = setCredentials(config, accountName, credentials);
      logFn(`token refreshed for ${accountName}`);
    }
    await saveConfig(config);
  } catch (err) {
    logFn(`usage refresh failed for ${accountName}: ${err?.message ?? err}`);
    // 兜底：usage 查询失败（如 429 限流）也要标记窗口已激活，避免下个周期重复 PING
    // 写入一个预估的 5h 窗口（ping 时间起算），后续 ping 拿到真实数据会覆盖
    if (!account.last_usage?.five_hour?.resets_at) {
      const FULL_WINDOW_MS = 5 * 60 * 60 * 1000;
      const placeholder = {
        five_hour: {
          utilization: 0,
          resets_at: new Date(pingedAt + FULL_WINDOW_MS).toISOString(),
        },
      };
      try {
        config = setLastUsage(config, accountName, placeholder);
        await saveConfig(config);
        logFn(`placeholder window set for ${accountName} (avoid re-ping loop)`);
      } catch (e) {
        logFn(`failed to set placeholder for ${accountName}: ${e?.message ?? e}`);
      }
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

  logFn('daemon: 主循环启动 (v0.3 动态调度)');

  // 内存状态：避免重复通知"全满"
  let allExhaustedNotified = false;
  // 内存状态：跟踪 limit_reached 标记（按帐号名）
  const limitReachedAt = new Map();

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
    for (const a of config.accounts) {
      if (!a.credentials) continue;
      if (!isExpiringSoon(a.credentials, 30 * 60 * 1000)) continue; // 30 min 预警
      const tsIso = toCST(nowFn());
      logFn(`[${tsIso}] proactive refresh: ${a.name} (expiring in <30min)`);
      try {
        const newCreds = await refreshAccessToken(a.credentials);
        const { setCredentials, saveConfig } = await import('./config.js');
        const updated = setCredentials(config, a.name, newCreds);
        await saveConfig(updated);
        config = updated;
        logFn(`[${tsIso}] proactive refresh ${a.name}: OK (next exp ${toCST(new Date(newCreds.expiresAt))})`);
      } catch (err) {
        logFn(`[${tsIso}] proactive refresh ${a.name}: FAIL ${err?.message ?? err}`);
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
          active = config.accounts.find(
            (a) => a.credentials?.accessToken === creds.accessToken,
          );
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
        logFn(`[${tsIso}] schedule: PING ${target.name} (health=${h})`);
        try {
          const result = await pingFn(target, config.ping_prompt);
          if (result?.success) {
            const pingedAtMs = nowFn().getTime();
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
          await performUseFromDaemon(target.name);
          if (config.scheduler?.notify !== false) {
            const fromName = active?.name ?? '上一个帐号';
            await dispatchNotification({
              title: 'relay-claude',
              subtitle: '已切换帐号',
              message: `${fromName} → ${target.name}`,
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

/** daemon 内调用 use 命令的核心 — 简化版，不退出进程 */
async function performUseFromDaemon(name) {
  // 用 dynamic import 避免循环依赖
  const useModule = await import('./commands/use.js');
  await useModule.default([name]);
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
