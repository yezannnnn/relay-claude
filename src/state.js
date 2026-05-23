// 运行时状态文件读写 + PID 锁
//
// 状态存储位置: <configDir>/state.json
// 字段:
//   daemon_pid:  守护进程 PID（未运行时为 null）
//   started_at:  守护进程启动时间 ISO 字符串
//   last_pings:  { [accountName]: ISO 时间字符串 | null }

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

const STATE_FILE = 'state.json';

function defaultState() {
  return {
    daemon_pid: null,
    started_at: null,
    last_pings: {},
  };
}

/** state.json 完整路径 */
export function getStatePath() {
  return path.join(getConfigDir(), STATE_FILE);
}

/**
 * 读取状态。文件不存在或解析失败时返回默认状态。
 */
export async function loadState() {
  const statePath = getStatePath();
  let raw;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultState();
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // state 文件相对易丢失（崩溃中写半截），降级到默认状态而非阻塞启动
    return defaultState();
  }

  return {
    daemon_pid:
      typeof parsed.daemon_pid === 'number' ? parsed.daemon_pid : null,
    started_at:
      typeof parsed.started_at === 'string' ? parsed.started_at : null,
    last_pings:
      parsed.last_pings && typeof parsed.last_pings === 'object'
        ? parsed.last_pings
        : {},
  };
}

/**
 * 写入状态。确保目录存在，权限 0o600。
 */
export async function saveState(state) {
  const dir = getConfigDir();
  const statePath = getStatePath();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fs.chmod(statePath, 0o600);
  } catch (err) {
    if (process.platform !== 'win32') {
      throw err;
    }
  }
}

/**
 * 更新 last_pings[name] = timestamp，并持久化。
 */
export async function recordPing(name, timestamp) {
  if (!name || typeof name !== 'string') {
    throw new Error('recordPing: name 必须为非空字符串');
  }
  const state = await loadState();
  state.last_pings = { ...state.last_pings, [name]: timestamp };
  await saveState(state);
  return state;
}

/**
 * 设置 daemon_pid 与 started_at（守护进程启动时调用）。
 */
export async function setDaemonPid(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid)) {
    throw new Error('setDaemonPid: pid 必须为数字');
  }
  const state = await loadState();
  state.daemon_pid = pid;
  state.started_at = new Date().toISOString();
  await saveState(state);
  return state;
}

/**
 * 清空 daemon_pid 与 started_at（守护进程停止时调用）。
 */
export async function clearDaemonPid() {
  const state = await loadState();
  state.daemon_pid = null;
  state.started_at = null;
  await saveState(state);
  return state;
}

/**
 * 检测当前 state.json 中记录的 daemon_pid 对应进程是否仍存活。
 *
 * 实现细节:
 *   - process.kill(pid, 0) 不真正发信号，仅检查 pid 是否存在/可访问
 *   - 进程不存在 → 抛 ESRCH，返回 false
 *   - 没有权限（EPERM）→ 进程存在但属于他人，仍视为存活返回 true
 *   - pid 为 null/非数字 → 返回 false
 */
export async function isDaemonAlive() {
  const state = await loadState();
  const pid = state.daemon_pid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      return true;
    }
    // ESRCH 或其他 → 进程不存在
    return false;
  }
}
