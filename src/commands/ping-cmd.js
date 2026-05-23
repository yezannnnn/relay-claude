// `interval-claude ping <name>` — 手动触发一次 ping，并记录到 state
//
// 用于测试某个 token 是否能正常调通 claude CLI。
//
// 调用者可以传 {silent: true} 来抑制输出 + 不退出（用于 TUI 调用）。

import { loadConfig, findAccount } from '../config.js';
import { recordPing } from '../state.js';
import { pingAccount } from '../pinger.js';

/**
 * 程序化 API（供 TUI 等调用）
 * @returns {Promise<{success, code, timedOut, elapsed, stdout, stderr}>}
 * 注意：失败不抛错也不退出，调用方自行处理。
 */
export async function runPing(name) {
  const config = await loadConfig();
  const account = findAccount(config, name);
  if (!account) {
    return { success: false, error: `找不到帐号: ${name}` };
  }
  const t0 = Date.now();
  const result = await pingAccount(account, config.ping_prompt);
  const elapsed = Date.now() - t0;
  if (result.success) {
    await recordPing(account.name, new Date().toISOString());
  }
  return { ...result, elapsed };
}

export default async function pingCommand(args) {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('用法: interval-claude ping <name>');
    process.exit(1);
  }

  console.log(`正在 ping ${name}...`);
  const result = await runPing(name);

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.success) {
    console.log(`OK (${result.elapsed}ms)`);
    if (result.stdout && result.stdout.trim()) {
      console.log('---');
      console.log(result.stdout.trim());
    }
  } else {
    console.error(`FAIL code=${result.code} timedOut=${result.timedOut} (${result.elapsed}ms)`);
    if (result.stderr && result.stderr.trim()) {
      console.error('---');
      console.error(result.stderr.trim());
    }
    process.exit(1);
  }
}
