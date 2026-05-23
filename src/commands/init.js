// `interval-claude init` — 交互式向导，添加第一个帐号
//
// 行为:
//   - 配置已存在帐号 → 提示 user 使用 `add` 命令，直接退出（不覆盖）
//   - 否则 readline 询问 name 与 token，调 addAccount + saveConfig 写入
//   - 首个帐号 offset_minutes 默认 0（primary）

import { loadConfig, saveConfig, addAccount, getConfigPath } from '../config.js';
import { prompt, closePrompt } from './prompt.js';

export default async function initCommand() {
  const config = await loadConfig();

  if ((config.accounts ?? []).length > 0) {
    console.error('配置已存在帐号，使用 `interval-claude add <name>` 添加更多帐号。');
    console.error(`配置文件: ${getConfigPath()}`);
    process.exit(1);
  }

  console.log('欢迎使用 intervalClaude — 让我们添加第一个帐号。');
  console.log('');

  try {
    const nameRaw = await prompt('帐号名 (例: primary): ');
    const name = nameRaw.trim();
    if (!name) {
      console.error('帐号名不能为空');
      process.exit(1);
    }

    const tokenRaw = await prompt('CLAUDE_CODE_OAUTH_TOKEN: ');
    const token = tokenRaw.trim();
    if (!token) {
      console.error('token 不能为空');
      process.exit(1);
    }

    const next = addAccount(config, { name, token, offsetMinutes: 0 });
    await saveConfig(next);

    console.log('');
    console.log(`已添加帐号 "${name}" (offset_minutes=0)`);
    console.log(`配置文件: ${getConfigPath()}`);
    console.log('');
    console.log('下一步：');
    console.log('  interval-claude add <name> --offset 100   # 添加更多帐号');
    console.log('  interval-claude start                     # 启动守护进程');
  } finally {
    closePrompt();
  }
}
