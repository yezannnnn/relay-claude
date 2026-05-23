// `interval-claude start|stop|status` — 守护进程控制
//
// 三个动作都很薄，只负责调 daemon.js 的函数 + 格式化输出。

import { loadConfig, saveConfig } from '../config.js';
import { startDaemon, stopDaemon, daemonStatus } from '../daemon.js';
import { getLogPath } from '../logger.js';
import { prompt as ask, closePrompt as close } from './prompt.js';

export async function startCommand(args = []) {
  let config = await loadConfig();
  if ((config.accounts ?? []).length === 0) {
    console.error('未配置任何帐号。先运行 `interval-claude add <name>` 添加帐号。');
    process.exit(1);
  }

  const names = config.accounts.map((a) => a.name).join(', ');
  console.log(`检测到 ${config.accounts.length} 个帐号: ${names}`);

  // 非交互模式 (--no-prompt) 跳过询问
  const skipPrompt = args.includes('--no-prompt');
  let stagger = true;
  if (!skipPrompt) {
    const answer = await ask('是否开启错峰激活? [Y/n]: ');
    close();
    stagger = answer.trim().toLowerCase() !== 'n';
  }

  if (stagger) {
    const N = config.accounts.length;
    const interval = Math.max(1, Math.floor(300 / N)); // 5h = 300min ÷ N
    config.interval_minutes = interval;
    config.accounts.forEach((a, i) => {
      a.offset_minutes = i * interval;
    });
    await saveConfig(config);
    console.log(`✅ 错峰安排（5h ÷ ${N} = ${interval} 分钟间隔）:`);
    for (const a of config.accounts) {
      const desc = a.offset_minutes === 0 ? '立即 ping' : `${a.offset_minutes} 分钟后 ping`;
      console.log(`   ${a.name.padEnd(15)} → ${desc}`);
    }
  } else {
    config.accounts.forEach((a) => {
      a.offset_minutes = 0;
    });
    await saveConfig(config);
    console.log('所有帐号将立即 ping（无错峰）');
  }

  const result = await startDaemon();
  if (result.alreadyRunning) {
    console.log(`守护进程已在运行 (pid=${result.pid})`);
    return;
  }
  console.log(`✅ 守护进程已启动 (pid=${result.pid})`);
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
