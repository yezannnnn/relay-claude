// src/notifier.js
// macOS 系统通知
// 仅 darwin 平台生效，其他平台静默 no-op
//
// 通知来源控制：
//   - macOS Big Sur 之后 osascript display notification 永远显示为"脚本编辑器"，
//     即使 tell application "iTerm2" 也不行（Apple 的安全策略）
//   - 真正能让通知归属到 iTerm2 / Terminal 的方式：terminal-notifier --sender <bundle-id>
//   - 因此本模块优先用 terminal-notifier，没装则回退 osascript
//   - bundle id 可通过 INTERVAL_CLAUDE_NOTIFY_SENDER 覆盖

import { spawn } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  watch,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { isTuiAttached } from './state.js';

const PENDING_FILE = 'pending-notification.json';

const BUNDLE_ID_MAP = {
  'iTerm.app': 'com.googlecode.iterm2',
  'Apple_Terminal': 'com.apple.Terminal',
  'vscode': 'com.microsoft.VSCode',
  'WarpTerminal': 'dev.warp.Warp-Stable',
  'ghostty': 'com.mitchellh.ghostty',
  'Hyper': 'co.zeit.hyper',
  'WezTerm': 'com.github.wez.wezterm',
};

/**
 * 转义字符串以嵌入 AppleScript 字符串字面量。
 * 需要处理：反斜杠 + 双引号。
 */
export function escapeForApplescript(s) {
  if (s == null) return '';
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 自动检测当前终端宿主 app（用于通知归属）。
 * 优先级：环境变量 > TERM_PROGRAM > 默认 iTerm2
 */
function detectNotificationHost() {
  if (process.env.INTERVAL_CLAUDE_NOTIFY_HOST) {
    return process.env.INTERVAL_CLAUDE_NOTIFY_HOST;
  }
  const tp = process.env.TERM_PROGRAM;
  if (tp === 'iTerm.app') return 'iTerm2';
  if (tp === 'Apple_Terminal') return 'Terminal';
  if (tp === 'vscode') return 'Code';
  if (tp === 'WarpTerminal') return 'Warp';
  return 'iTerm2';
}

/**
 * 自动检测发送方 bundle ID（用于 terminal-notifier --sender）。
 */
function detectSenderBundleId() {
  if (process.env.INTERVAL_CLAUDE_NOTIFY_SENDER) {
    return process.env.INTERVAL_CLAUDE_NOTIFY_SENDER;
  }
  const tp = process.env.TERM_PROGRAM;
  return BUNDLE_ID_MAP[tp] ?? 'com.googlecode.iterm2';
}

/**
 * 尝试通过 terminal-notifier 发送（可以正确显示来源 app 图标）。
 * @returns {Promise<boolean>}
 */
async function sendViaTerminalNotifier({ title, subtitle, message, sound, sender }) {
  return new Promise((resolve) => {
    const args = ['-message', message];
    if (title) args.push('-title', title);
    if (subtitle) args.push('-subtitle', subtitle);
    if (sound) args.push('-sound', sound);
    if (sender) args.push('-sender', sender);
    const child = spawn('terminal-notifier', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false)); // 未安装
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * 构造 osascript 命令参数数组。
 * 包一层 `tell application "<host>"` 让通知归属到该 app（图标变成宿主 app 的图标）。
 */
export function buildOsascriptArgs({ title, subtitle, message, sound, host }) {
  const parts = [`display notification "${escapeForApplescript(message)}"`];
  if (title) parts.push(`with title "${escapeForApplescript(title)}"`);
  if (subtitle) parts.push(`subtitle "${escapeForApplescript(subtitle)}"`);
  if (sound) parts.push(`sound name "${escapeForApplescript(sound)}"`);
  const inner = parts.join(' ');
  const script = host
    ? `tell application "${escapeForApplescript(host)}" to ${inner}`
    : inner;
  return ['-e', script];
}

/**
 * 发送系统通知。
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.subtitle]
 * @param {string} opts.message
 * @param {string} [opts.sound='Submarine']
 * @param {string} [opts.host] - 覆盖默认通知宿主 app
 * @returns {Promise<boolean>}
 */
export async function sendNotification({
  title,
  subtitle,
  message,
  sound = 'Submarine',
  host,
  sender,
} = {}) {
  if (process.platform !== 'darwin') return false;
  if (!message) return false;

  // 优先 terminal-notifier — 可正确显示来源 app 图标
  const effectiveSender = sender ?? detectSenderBundleId();
  const tnOk = await sendViaTerminalNotifier({
    title,
    subtitle,
    message,
    sound,
    sender: effectiveSender,
  });
  if (tnOk) return true;

  // 回退：osascript（通知来源会显示为"脚本编辑器"，这是 macOS 限制）
  const effectiveHost = host ?? detectNotificationHost();
  return new Promise((resolve) => {
    const args = buildOsascriptArgs({
      title,
      subtitle,
      message,
      sound,
      host: effectiveHost,
    });
    const child = spawn('osascript', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

// ─── TUI 通知通道：daemon 写文件 → TUI 监听 → OSC 9 弹 ─────────────────────

function getPendingPath() {
  return path.join(getConfigDir(), PENDING_FILE);
}

/**
 * 写一条待处理通知到共享文件（供 TUI 监听并用 OSC 9 弹）。
 */
export function writePendingNotification({ title, subtitle, message, sound } = {}) {
  if (!message) return false;
  try {
    mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    const payload = { title, subtitle, message, sound, ts: Date.now() };
    writeFileSync(getPendingPath(), JSON.stringify(payload), {
      encoding: 'utf8',
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * TUI 端：监听通知文件，新通知到来时调用 callback({title,subtitle,message,sound,ts})。
 * 返回 stop() 函数。
 */
export function watchPendingNotifications(callback) {
  const file = getPendingPath();
  let lastTs = 0;

  // 启动时记录当前 ts，避免重复触发历史通知
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      lastTs = data.ts ?? 0;
    }
  } catch {
    // 忽略
  }

  function tryConsume() {
    try {
      if (!existsSync(file)) return;
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data.ts && data.ts > lastTs) {
        lastTs = data.ts;
        callback(data);
      }
    } catch {
      // 文件损坏 / 读写竞态 → 忽略
    }
  }

  let watcher = null;
  try {
    // 监听文件本身
    if (existsSync(file)) {
      watcher = watch(file, { persistent: false }, tryConsume);
    } else {
      // 文件还不存在 → 监听父目录，捕获文件创建
      watcher = watch(getConfigDir(), { persistent: false }, (_evt, name) => {
        if (name === PENDING_FILE) tryConsume();
      });
    }
  } catch {
    // 监听失败（如 ENOSPC），走纯轮询
  }

  // 兜底轮询（fs.watch 在某些场景不可靠）
  const interval = setInterval(tryConsume, 1500);

  return () => {
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // 忽略
      }
    }
    clearInterval(interval);
  };
}

/**
 * 在当前 stdout 上用 iTerm2 OSC 9 弹通知，通知来源 = iTerm2。
 * 仅当 stdout 是 TTY 且终端是 iTerm.app 时生效。
 */
export function emitIterm2Notification(message) {
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM_PROGRAM !== 'iTerm.app') return false;
  if (!message) return false;
  try {
    process.stdout.write(`\x1b]9;${message}\x07`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 智能 dispatch：
 *   - TUI 在前台运行 + iTerm2 → 写共享文件，让 TUI 用 OSC 9 弹（来源 = iTerm2）
 *   - 否则 → 走 terminal-notifier / osascript 系统通知
 *
 * daemon 应该用这个函数发通知，而不是直接调 sendNotification。
 */
export async function dispatchNotification(opts = {}) {
  if (process.platform !== 'darwin') return false;
  if (!opts.message) return false;
  try {
    const tuiAlive = await isTuiAttached();
    if (tuiAlive) {
      writePendingNotification(opts);
      return true;
    }
  } catch {
    // isTuiAttached 失败 → 走 fallback
  }
  return sendNotification(opts);
}
