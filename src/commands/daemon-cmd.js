// `interval-claude start|stop|status` — 守护进程控制
//
// 三个动作都很薄，只负责调 daemon.js 的函数 + 格式化输出。

import { loadConfig } from '../config.js';
import { startDaemon, stopDaemon, daemonStatus } from '../daemon.js';
import { getLogPath } from '../logger.js';

export async function startCommand() {
  const config = await loadConfig();
  if ((config.accounts ?? []).length === 0) {
    console.error('未配置任何帐号。先运行 `interval-claude init` 添加帐号。');
    process.exit(1);
  }

  const result = await startDaemon();
  if (result.alreadyRunning) {
    console.log(`守护进程已在运行 (pid=${result.pid})`);
    return;
  }
  console.log(`守护进程已启动 (pid=${result.pid})`);
  console.log(`日志: ${getLogPath()}`);
}

export async function stopCommand() {
  const result = await stopDaemon();
  if (!result.wasRunning) {
    console.log('守护进程未在运行');
    return;
  }
  console.log('守护进程已停止');
}

export async function statusCommand() {
  const status = await daemonStatus();
  if (!status.running) {
    console.log('守护进程未运行');
    console.log('运行 `interval-claude start` 启动');
    return;
  }
  console.log(`守护进程运行中`);
  console.log(`  pid:        ${status.pid}`);
  console.log(`  started_at: ${status.startedAt}`);
  console.log(`  uptime:     ${status.uptime}`);
  console.log(`  log:        ${getLogPath()}`);
}
