#!/usr/bin/env node
// daemon-worker —— 被 startDaemon spawn 出来的实际后台进程入口
//
// 职责:
//   1. 写自己的 pid 到 state.json
//   2. 安装 SIGTERM / SIGINT 处理器，设置 stopping 标志
//   3. 调用 runDaemon，shouldStop 注入 stopping
//   4. 退出前清空 state.daemon_pid（finally）

import { runDaemon } from './daemon.js';
import { setDaemonPid, clearDaemonPid } from './state.js';
import { appendLog } from './logger.js';

let stopping = false;
function handleSignal(signal) {
  stopping = true;
  appendLog(`daemon-worker: 收到 ${signal}，准备退出`);
}
process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));

await setDaemonPid(process.pid);
appendLog(`daemon-worker: 启动 pid=${process.pid}`);

try {
  await runDaemon({ shouldStop: () => stopping });
} catch (err) {
  appendLog(`daemon-worker: 主循环异常退出: ${err?.message ?? err}`);
} finally {
  await clearDaemonPid();
  appendLog('daemon-worker: 已清理状态，退出');
}
