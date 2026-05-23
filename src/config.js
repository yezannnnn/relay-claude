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

const DEFAULT_CONFIG = Object.freeze({
  interval_minutes: 100,
  ping_prompt: 'hi',
  accounts: [],
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

/**
 * 返回默认空配置（深拷贝，避免污染常量）。
 */
function defaultConfig() {
  return {
    interval_minutes: DEFAULT_CONFIG.interval_minutes,
    ping_prompt: DEFAULT_CONFIG.ping_prompt,
    accounts: [],
  };
}

/**
 * 读取并解析 config.json。
 * 文件不存在时返回默认空配置。
 * 解析失败时抛出错误（不静默吞掉数据损坏问题）。
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
    accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
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
  // 显式指定 mode，避免新建时受 umask 影响
  await fs.writeFile(configPath, json, { encoding: 'utf8', mode: 0o600 });
  // 已存在的文件不会被 writeFile 的 mode 覆盖权限，显式 chmod 一次
  try {
    await fs.chmod(configPath, 0o600);
  } catch (err) {
    // Windows 上 chmod 是 no-op，忽略 EPERM/ENOSYS 之类的差异
    if (process.platform !== 'win32') {
      throw err;
    }
  }
}

/**
 * 纯函数：返回新增帐号后的 config 副本。
 * 重名抛错。
 */
export function addAccount(config, { name, token, offsetMinutes }) {
  if (!name || typeof name !== 'string') {
    throw new Error('addAccount: name 必须为非空字符串');
  }
  if (!token || typeof token !== 'string') {
    throw new Error('addAccount: token 必须为非空字符串');
  }
  if (typeof offsetMinutes !== 'number' || !Number.isFinite(offsetMinutes)) {
    throw new Error('addAccount: offsetMinutes 必须为数字');
  }

  const existing = (config.accounts ?? []).find((a) => a.name === name);
  if (existing) {
    throw new Error(`帐号已存在: ${name}`);
  }

  return {
    ...config,
    accounts: [
      ...(config.accounts ?? []),
      { name, token, offset_minutes: offsetMinutes },
    ],
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
