// CLI 路由 — 把命令名映射到 commands/* 模块
//
// 设计:
//   - 每个 command 模块导出一个 async 函数，签名为 (args: string[]) => Promise<void>
//   - 路由在这里集中，命令实现独立，便于单元测试
//   - 未知命令 → 打印 help + exit 1
//   - 全局 --help / --version 优先

import initCommand from './commands/init.js';
import addCommand from './commands/add.js';
import listCommand from './commands/list.js';
import {
  startCommand,
  stopCommand,
  statusCommand,
} from './commands/daemon-cmd.js';
import switchCommand from './commands/switch.js';
import pingCommand from './commands/ping-cmd.js';
import watchCommand from './commands/watch.js';

const VERSION = '0.1.0';

/**
 * 主入口。args = process.argv.slice(2)
 */
export async function main(args) {
  const cmd = args[0];
  const rest = args.slice(1);

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(`interval-claude ${VERSION}`);
    return;
  }

  switch (cmd) {
    case 'init':
      return initCommand(rest);
    case 'add':
      return addCommand(rest);
    case 'list':
    case 'ls':
      return listCommand(rest);
    case 'start':
      return startCommand(rest);
    case 'stop':
      return stopCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'switch':
      return switchCommand(rest);
    case 'ping':
      return pingCommand(rest);
    case 'watch':
      return watchCommand(rest);
    default:
      console.error(`未知命令: ${cmd}`);
      console.error('运行 `interval-claude --help` 查看可用命令');
      process.exit(1);
  }
}

function printHelp() {
  console.log(`interval-claude ${VERSION} — 错峰激活多个 Claude 帐号

用法:
  interval-claude <command> [options]

命令:
  init                          交互式向导，添加第一个帐号
  add <name> [--offset N]       添加帐号 (token 从 stdin 读取)
  list                          列出所有帐号 + 状态
  start                         启动守护进程
  stop                          停止守护进程
  status                        查看守护进程状态
  switch [name] [--shell S]     输出 shell 命令切换 token
                                  S = bash | cmd | pwsh (默认按平台)
                                  不带 name → 自动选剩余时间最多的帐号
                                  典型用法: eval "$(interval-claude switch)"
  ping <name>                   手动 ping 某帐号（测试用）
  watch                         实时仪表盘 (Ctrl+C 退出)
  --help, -h                    显示此帮助
  --version, -v                 显示版本

配置目录: \$INTERVAL_CLAUDE_HOME 或 ~/.intervalClaude
`);
}
