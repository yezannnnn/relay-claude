// `interval-claude ping <name>` — 手动触发一次 ping，并记录到 state
//
// 用于测试某个 token 是否能正常调通 claude CLI。

import { loadConfig, findAccount } from '../config.js';
import { recordPing } from '../state.js';
import { pingAccount } from '../pinger.js';

export default async function pingCommand(args) {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('用法: interval-claude ping <name>');
    process.exit(1);
  }

  const config = await loadConfig();
  const account = findAccount(config, name);
  if (!account) {
    console.error(`找不到帐号: ${name}`);
    process.exit(1);
  }

  console.log(`正在 ping ${name}...`);
  const t0 = Date.now();
  const result = await pingAccount(account, config.ping_prompt);
  const elapsed = Date.now() - t0;

  if (result.success) {
    await recordPing(account.name, new Date().toISOString());
    console.log(`OK (${elapsed}ms)`);
    if (result.stdout && result.stdout.trim()) {
      console.log('---');
      console.log(result.stdout.trim());
    }
  } else {
    console.error(`FAIL code=${result.code} timedOut=${result.timedOut} (${elapsed}ms)`);
    if (result.stderr && result.stderr.trim()) {
      console.error('---');
      console.error(result.stderr.trim());
    }
    process.exit(1);
  }
}
