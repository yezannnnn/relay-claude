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

import { loadConfig } from './config.js';
import {
  loadState,
  recordPing,
  setDaemonPid,
  clearDaemonPid,
  isDaemonAlive,
} from './state.js';
import { dueAccounts } from './scheduler.js';
import { pingWithRetry } from './pinger.js';
import { appendLog } from './logger.js';

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

  logFn('daemon: 主循环启动');

  while (!shouldStop()) {
    let config;
    let state;
    try {
      config = await loadConfig();
      state = await loadState();
    } catch (err) {
      logFn(`daemon: 读取 config/state 失败: ${err?.message ?? err}`);
      await interruptibleSleep(checkIntervalMs, shouldStop);
      continue;
    }

    const now = nowFn();
    let due;
    try {
      due = dueAccounts(state, config, now);
    } catch (err) {
      logFn(`daemon: dueAccounts 计算失败: ${err?.message ?? err}`);
      due = [];
    }

    for (const account of due) {
      if (shouldStop()) break;
      const tsIso = nowFn().toISOString();
      try {
        const result = await pingFn(account, config.ping_prompt);
        const success = !!result?.success;
        if (success) {
          await recordPing(account.name, nowFn().toISOString());
          logFn(`[${tsIso}] ping ${account.name}: OK`);
        } else {
          const detail =
            result?.lastResult?.stderr ||
            result?.stderr ||
            result?.lastResult?.code ||
            'unknown';
          logFn(`[${tsIso}] ping ${account.name}: FAIL (${String(detail).trim()})`);
        }
      } catch (err) {
        // 单帐号异常吞掉，不让循环挂掉
        logFn(`[${tsIso}] ping ${account.name}: ERROR ${err?.message ?? err}`);
      }
    }

    if (shouldStop()) break;
    await interruptibleSleep(checkIntervalMs, shouldStop);
  }

  logFn('daemon: 主循环退出');
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
