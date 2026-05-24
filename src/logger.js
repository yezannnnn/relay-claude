// 简单日志写入 — 追加到 <configDir>/daemon.log
//
// 用于守护进程后台运行时记录 ping 结果、错误等事件。
// 同步追加（fs.appendFileSync）— 调用方常常在异常 catch 中调用，
// 不能再依赖异步链路；同步追加对低频日志量足够。

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';

const LOG_FILE = 'daemon.log';

/** 把 Date 格式化为东八区时间字符串，如 2026-05-24T18:42:57+08:00 */
export function toCST(date) {
  const cstMs = date.getTime() + 8 * 3_600_000;
  return new Date(cstMs).toISOString().replace('Z', '+08:00');
}

/** daemon.log 完整路径 */
export function getLogPath() {
  return path.join(getConfigDir(), LOG_FILE);
}

/**
 * 追加一行日志到 daemon.log。
 * 自动加东八区时间戳前缀和换行。
 * 失败时静默（日志写入不应让主流程崩溃）。
 *
 * @param {string} message - 日志正文
 */
export function appendLog(message) {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = `[${toCST(new Date())}] ${message}\n`;
    appendFileSync(getLogPath(), line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 日志写入失败不应阻塞主流程
  }
}
