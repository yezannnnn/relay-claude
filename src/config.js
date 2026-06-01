// 配置文件读写
//
// 配置存储位置:
//   Mac/Linux: ~/.intervalClaude/config.json
//   Windows:   %USERPROFILE%\.intervalClaude\config.json
//
// 可通过环境变量 INTERVAL_CLAUDE_HOME 覆盖默认目录（用于测试隔离）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR_NAME = '.intervalClaude';
const CONFIG_FILE = 'config.json';
const LOCK_FILE = 'config.lock';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 15000;
const LOCK_POLL_MS = 20;

const DEFAULT_SCHEDULER = Object.freeze({
  enabled: true,
  stagger_min: null, // null = 自动按 300/N 计算
  sub_weights: {
    pro: 1,
    max_5x: 5,
    max_20x: 20,
    team: 10,
    _default: 1,
  },
  expire_threshold_min: 3,
  auto_switch: true,
  notify: true,
});

const DEFAULT_CONFIG = Object.freeze({
  interval_minutes: 100,
  ping_prompt: 'hi',
  accounts: [],
  scheduler: DEFAULT_SCHEDULER,
});

/**
 * 配置目录绝对路径。
 * 优先读取 INTERVAL_CLAUDE_HOME 环境变量（测试用），否则用 ~/.intervalClaude。
 */
export function getConfigDir() {
  const override = process.env.INTERVAL_CLAUDE_HOME;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), DIR_NAME);
}

/** config.json 完整路径 */
export function getConfigPath() {
  return path.join(getConfigDir(), CONFIG_FILE);
}

function getLockPath() {
  return path.join(getConfigDir(), LOCK_FILE);
}

/**
 * 原子创建锁文件（O_EXCL）。
 * - 自动清理超过 LOCK_STALE_MS 的过期锁
 * - 超时 LOCK_TIMEOUT_MS 后抛错
 */
async function acquireLock() {
  const lockPath = getLockPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL — 原子操作，文件已存在时抛 EEXIST
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return lockPath;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // 检查锁是否过期（持锁进程已崩溃）
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // 锁文件在 stat 前消失，立即重试
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }

  throw new Error(
    `updateConfig: 获取文件锁超时 (${LOCK_TIMEOUT_MS}ms) — 检查是否有僵尸进程持有 ${lockPath}`
  );
}

async function releaseLock(lockPath) {
  await fs.unlink(lockPath).catch(() => {});
}

/**
 * 返回默认空配置（深拷贝，避免污染常量）。
 */
function defaultConfig() {
  return {
    interval_minutes: DEFAULT_CONFIG.interval_minutes,
    ping_prompt: DEFAULT_CONFIG.ping_prompt,
    accounts: [],
    scheduler: { ...DEFAULT_SCHEDULER, sub_weights: { ...DEFAULT_SCHEDULER.sub_weights } },
  };
}

/**
 * 读取并解析 config.json。
 * 文件不存在时返回默认空配置。
 * 解析失败时抛出错误（不静默吞掉数据损坏问题）。
 *
 * 迁移逻辑：v0.1 账户含有 token 字段时，重命名为 legacy_token。
 */
export async function loadConfig() {
  const configPath = getConfigPath();
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultConfig();
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`配置文件损坏 (${configPath}): ${err.message}`);
  }

  // 迁移 v0.1 token 字段到 legacy_token
  const migratedAccounts = Array.isArray(parsed.accounts)
    ? parsed.accounts.map((account) => {
        // 如果账户有 token 字段但没有 credentials，则迁移到 legacy_token
        if (account.token && !account.credentials) {
          const { token, ...rest } = account;
          return {
            ...rest,
            legacy_token: token,
          };
        }
        return account;
      })
    : [];

  // 合并 scheduler 配置：用户配置覆盖默认值
  const userScheduler = parsed.scheduler && typeof parsed.scheduler === 'object'
    ? parsed.scheduler
    : {};
  const mergedScheduler = {
    ...DEFAULT_SCHEDULER,
    ...userScheduler,
    sub_weights: {
      ...DEFAULT_SCHEDULER.sub_weights,
      ...(userScheduler.sub_weights ?? {}),
    },
  };

  // 补全缺失字段，保持向前兼容
  return {
    interval_minutes:
      typeof parsed.interval_minutes === 'number'
        ? parsed.interval_minutes
        : DEFAULT_CONFIG.interval_minutes,
    ping_prompt:
      typeof parsed.ping_prompt === 'string'
        ? parsed.ping_prompt
        : DEFAULT_CONFIG.ping_prompt,
    accounts: migratedAccounts,
    scheduler: mergedScheduler,
  };
}

/**
 * 写入 config.json。
 * - 确保目录存在
 * - 文件权限 0o600（仅本人可读写）
 * - 目录权限 0o700
 */
export async function saveConfig(config) {
  const dir = getConfigDir();
  const configPath = getConfigPath();

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const json = JSON.stringify(config, null, 2);
  // 写入临时文件再 rename，保证写操作原子性（不会出现部分写入的损坏文件）
  const tmpPath = `${configPath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(tmpPath, 0o600);
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  }
  try {
    // POSIX rename 是原子操作 — 目标文件被瞬间替换
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * 跨进程安全的原子更新 config。
 *
 * 用法：
 *   await updateConfig((cfg) => setLastUsage(cfg, 'A', usage));
 *
 * 通过文件锁（O_EXCL）保证同一时刻只有一个进程（或异步上下文）执行
 * read-modify-write，解决 TUI 和 Daemon 并发写导致的数据覆盖问题。
 * saveConfig 内部使用 tmp+rename 保证写操作本身的原子性。
 */
export async function updateConfig(updater) {
  if (typeof updater !== 'function') {
    throw new Error('updateConfig: updater 必须是函数');
  }
  // 确保目录存在，以便锁文件可以创建
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 });
  const lockPath = await acquireLock();
  try {
    const current = await loadConfig();
    const next = updater(current);
    if (!next || typeof next !== 'object') {
      throw new Error('updateConfig: updater 必须返回新 config 对象');
    }
    await saveConfig(next);
    return next;
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * 纯函数：返回新增帐号后的 config 副本。
 * 重名抛错。
 *
 * 支持两种输入格式：
 * - v0.2: { name, credentials: {...}, offsetMinutes }
 * - v0.1: { name, token: "...", offsetMinutes }（向后兼容）
 */
export function addAccount(config, { name, credentials = null, token = null, offsetMinutes = 0 }) {
  if (!name || typeof name !== 'string') {
    throw new Error('addAccount: name 必须为非空字符串');
  }

  // 必须至少提供 credentials 或 token 中的一个
  if (!credentials && !token) {
    throw new Error('addAccount: 必须提供 credentials 或 token');
  }

  // 不能同时提供 credentials 和 token
  if (credentials && token) {
    throw new Error('addAccount: 不能同时提供 credentials 和 token');
  }

  if (typeof offsetMinutes !== 'number' || !Number.isFinite(offsetMinutes)) {
    throw new Error('addAccount: offsetMinutes 必须为数字');
  }

  const existing = (config.accounts ?? []).find((a) => a.name === name);
  if (existing) {
    throw new Error(`帐号已存在: ${name}`);
  }

  let newAccount = { name, offset_minutes: offsetMinutes };
  if (credentials) {
    newAccount.credentials = credentials;
  } else if (token) {
    newAccount.legacy_token = token;
  }

  return {
    ...config,
    accounts: [...(config.accounts ?? []), newAccount],
  };
}

/**
 * 纯函数：返回移除指定帐号后的 config 副本。
 * 帐号不存在时静默返回（调用方可结合 findAccount 做存在性检查）。
 */
export function removeAccount(config, name) {
  return {
    ...config,
    accounts: (config.accounts ?? []).filter((a) => a.name !== name),
  };
}

/**
 * 返回指定帐号对象，找不到时返回 undefined。
 */
export function findAccount(config, name) {
  return (config.accounts ?? []).find((a) => a.name === name);
}

/**
 * 获取账户的访问令牌。
 * 优先返回 credentials.accessToken，否则返回 legacy_token。
 * 都不存在时返回 null。
 *
 * 用途：兼容 v0.1（legacy_token）和 v0.2（credentials.accessToken）两种格式。
 */
export function getAccessToken(account) {
  if (!account) return null;
  if (account.credentials?.accessToken) {
    return account.credentials.accessToken;
  }
  if (account.legacy_token) {
    return account.legacy_token;
  }
  return null;
}

/**
 * 纯函数：为指定账户设置新的 credentials，并清除 legacy_token。
 * 账户不存在时抛错。
 *
 * 用途：当完成 OAuth 流程后，用新的 credentials 替换 v0.1 的 legacy_token。
 */
export function setCredentials(config, name, credentials) {
  const account = (config.accounts ?? []).find((a) => a.name === name);
  if (!account) {
    throw new Error(`account "${name}" not found`);
  }
  account.credentials = credentials;
  delete account.legacy_token;
  return config;
}

/**
 * 纯函数：为指定账户设置 last_usage 使用情况统计。
 * 账户不存在时抛错。
 *
 * 用途：存储 OAuth provider 返回的速率限制和使用统计数据。
 */
export function setLastUsage(config, name, usage) {
  const account = (config.accounts ?? []).find((a) => a.name === name);
  if (!account) {
    throw new Error(`account "${name}" not found`);
  }
  account.last_usage = usage;
  return config;
}
