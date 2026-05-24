// src/notifier.js
// macOS 系统通知 (via osascript)
// 仅 darwin 平台生效，其他平台静默 no-op

import { spawn } from 'node:child_process';

/**
 * 转义字符串以嵌入 AppleScript 字符串字面量。
 * 需要处理：反斜杠 + 双引号。
 */
export function escapeForApplescript(s) {
  if (s == null) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 构造 osascript 命令参数数组。
 */
export function buildOsascriptArgs({ title, subtitle, message, sound }) {
  const parts = [`display notification "${escapeForApplescript(message)}"`];
  if (title) parts.push(`with title "${escapeForApplescript(title)}"`);
  if (subtitle) parts.push(`subtitle "${escapeForApplescript(subtitle)}"`);
  if (sound) parts.push(`sound name "${escapeForApplescript(sound)}"`);
  return ['-e', parts.join(' ')];
}

/**
 * 发送系统通知。
 * @returns {Promise<boolean>} - 成功 true，失败/不支持平台 false
 */
export async function sendNotification({ title, subtitle, message, sound = 'Submarine' } = {}) {
  if (process.platform !== 'darwin') return false;
  if (!message) return false;
  return new Promise((resolve) => {
    const args = buildOsascriptArgs({ title, subtitle, message, sound });
    const child = spawn('osascript', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
