// `interval-claude switch [name] [--shell bash|cmd|pwsh]`
//
// 输出一行 shell 命令到 stdout，让用户 eval 来切换 token：
//   bash:  export CLAUDE_CODE_OAUTH_TOKEN='xxx'
//   cmd:   set CLAUDE_CODE_OAUTH_TOKEN=xxx
//   pwsh:  $env:CLAUDE_CODE_OAUTH_TOKEN='xxx'
//
// 关键：
//   - stdout 只有那一行命令（用户会 `eval $(interval-claude switch)`）
//   - 提示/帐号名等信息一律走 stderr，不污染 eval
//   - 默认 shell：Windows 用 cmd，否则 bash

import { loadConfig, findAccount } from '../config.js';
import { loadState } from '../state.js';
import { recommendedAccount } from '../scheduler.js';

function defaultShell() {
  return process.platform === 'win32' ? 'cmd' : 'bash';
}

function formatExport(shell, value) {
  switch (shell) {
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'fish': {
      // 单引号包裹 + 转义内部单引号 (POSIX trick)
      const escaped = String(value).replace(/'/g, `'\\''`);
      return `export CLAUDE_CODE_OAUTH_TOKEN='${escaped}'`;
    }
    case 'cmd': {
      // cmd 不支持引号包裹值，原样输出；值中含特殊字符（&|<>^）可能出问题，
      // 但 token 通常是 base64-like 字符集，不会触发。
      return `set CLAUDE_CODE_OAUTH_TOKEN=${value}`;
    }
    case 'pwsh':
    case 'powershell': {
      // PowerShell 单引号字面量；内部单引号需 `'` 两次
      const escaped = String(value).replace(/'/g, `''`);
      return `$env:CLAUDE_CODE_OAUTH_TOKEN='${escaped}'`;
    }
    default:
      throw new Error(`未知 shell: ${shell}`);
  }
}

export default async function switchCommand(args) {
  // 解析参数：可选 name + 可选 --shell <name>
  let name;
  let shell = defaultShell();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--shell') {
      const v = args[i + 1];
      if (!v) {
        console.error('--shell 缺少参数值 (bash|cmd|pwsh)');
        process.exit(1);
      }
      shell = v.toLowerCase();
      i++;
    } else if (!a.startsWith('--') && !name) {
      name = a;
    }
  }

  const config = await loadConfig();
  if ((config.accounts ?? []).length === 0) {
    console.error('未配置任何帐号。运行 `interval-claude init` 开始配置。');
    process.exit(1);
  }

  let account;
  if (name) {
    account = findAccount(config, name);
    if (!account) {
      console.error(`找不到帐号: ${name}`);
      process.exit(1);
    }
  } else {
    const state = await loadState();
    account = recommendedAccount(state, config);
    if (!account) {
      console.error('无法推荐帐号 — 配置中没有可用帐号');
      process.exit(1);
    }
  }

  let line;
  try {
    line = formatExport(shell, account.token);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // 提示信息到 stderr（不污染 eval）
  console.error(`# 切换到帐号: ${account.name}`);
  // 实际命令到 stdout
  console.log(line);
}
