// v0.2 remove — 删除指定帐号
// 支持 --yes / -y 跳过删除确认

import { loadConfig, removeAccount, updateConfig } from '../config.js';
import { prompt as ask, closePrompt as close } from './prompt.js';

export default async function removeCommand(args) {
  const positional = args.filter(a => !a.startsWith('--') && !a.startsWith('-'));
  const name = positional[0];

  if (!name) {
    console.error('用法: interval-claude remove <name> [--yes]');
    process.exit(1);
  }

  const config = await loadConfig();
  const account = config.accounts.find(a => a.name === name);
  if (!account) {
    console.error(`帐号 "${name}" 不存在`);
    process.exit(1);
  }

  const skipConfirm = args.includes('--yes') || args.includes('-y');
  if (!skipConfirm) {
    const answer = await ask(`⚠️  确认删除帐号 ${name}? [y/N]: `);
    close();
    if (answer.toLowerCase() !== 'y') {
      console.log('已取消');
      return;
    }
  }

  await updateConfig((cfg) => removeAccount(cfg, name));
  console.log(`✅ 已删除 ${name}`);
}
