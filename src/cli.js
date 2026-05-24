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
import useCommand from './commands/use.js';
import pingCommand from './commands/ping-cmd.js';
import watchCommand from './commands/watch.js';
import removeCommand from './commands/remove.js';
import tuiCommand from './commands/tui.js';

const VERSION = '0.3.0';

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
    case 'remove':
    case 'rm':
      return removeCommand(rest);
    case 'start':
      return startCommand(rest);
    case 'stop':
      return stopCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'switch':       // v0.1 别名
    case 'export-env':
      return switchCommand(rest);
    case 'use':
      return useCommand(rest);
    case 'ping':
      return pingCommand(rest);
    case 'watch':
      return watchCommand(rest);
    case 'tui':
      return tuiCommand(rest);
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

帐号管理:
  add [name] [--offset N]       从 macOS Keychain 捕获 OAuth 凭证
                                  无参数 → 交互式批量
                                  需先 claude /login 登录目标帐号
  list [--refresh]              列出帐号 + 订阅类型 + usage
  remove <name> [--yes]         删除帐号
  use <name>                    全局切换 Keychain（所有终端立即生效）
  export-env [name] [--shell S] 输出 shell export 命令（仅当前 shell）
                                  S = bash | cmd | pwsh
                                  别名: switch（v0.1 兼容）

守护进程:
  start                         启动动态调度（按 sub 等级自动错峰）
  stop                          停止
  status                        查看状态
  ping <name>                   手动触发 ping
  tui                           实时多帐号仪表盘（按 q 退出）
  watch                         简化版仪表盘（v0.1 兼容）

其他:
  init                          交互式向导（旧版兼容，建议直接 add）
  --help, -h                    显示此帮助
  --version, -v                 显示版本

配置目录: \$INTERVAL_CLAUDE_HOME 或 ~/.intervalClaude
`);
}
