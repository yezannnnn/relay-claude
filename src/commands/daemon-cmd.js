// `interval-claude start|stop|status` — 守护进程控制
//
// 三个动作都很薄，只负责调 daemon.js 的函数 + 格式化输出。

import { loadConfig } from '../config.js';
import { startDaemon, stopDaemon, daemonStatus } from '../daemon.js';
import { getLogPath } from '../logger.js';
import { printBanner, VERSION } from '../banner.js';

export async function startCommand(args = []) {
  printBanner({ version: VERSION, tagline: '启动守护进程' });

  const config = await loadConfig();
  if ((config.accounts ?? []).length === 0) {
    console.error('未配置任何帐号。先运行 `relay-claude add <name>` 添加帐号。');
    process.exit(1);
  }

  const N = config.accounts.length;
  const staggerMin =
    config.scheduler?.stagger_min ?? Math.max(1, Math.round(300 / N));
  const names = config.accounts.map((a) => a.name).join(', ');

  console.log(`检测到 ${N} 个帐号: ${names}`);
  console.log(`✅ 动态调度已启用`);
  console.log(`   - 错峰间隔: ${staggerMin} 分钟 (300 ÷ ${N})`);
  console.log(`   - 自动 ping 启动备用窗口（按 sub 等级 + 健康度）`);
  console.log(`   - 主帐号 100% 自动切换`);
  console.log(
    `   - macOS 通知: ${config.scheduler?.notify !== false ? '开' : '关'}`,
  );

  const result = await startDaemon();
  if (result.alreadyRunning) {
    console.log(`守护进程已在运行 (pid=${result.pid})`);
  } else {
    console.log(`\n✅ 守护进程已启动 (pid=${result.pid})`);
    console.log(`日志: ${getLogPath()}`);
  }

  // start 之后默认进入 TUI（除非 --no-tui 或 stdin 不是 TTY）
  const noTui = args.includes('--no-tui');
  if (!noTui && process.stdin.isTTY) {
    // 给 daemon 一点时间初始化
    await new Promise((r) => setTimeout(r, 500));
    const tuiModule = await import('./tui.js');
    await tuiModule.default();
  }
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
