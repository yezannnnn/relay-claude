// `interval-claude add <name> [--offset N]` — 添加帐号
//
// 行为:
//   - name 必填位置参数
//   - --offset <minutes>: 可选，未指定时取「已有帐号数 * interval_minutes」
//     这样默认错峰，新帐号自动排在队尾
//   - token 从 stdin 单行读取

import { loadConfig, saveConfig, addAccount, getConfigPath } from '../config.js';
import { prompt, closePrompt } from './prompt.js';

export default async function addCommand(args) {
  // args = ['<name>', ...options]
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error('用法: interval-claude add <name> [--offset <minutes>]');
    process.exit(1);
  }

  const offsetIdx = args.indexOf('--offset');
  let offsetMinutes;
  if (offsetIdx !== -1) {
    const v = args[offsetIdx + 1];
    if (v === undefined) {
      console.error('--offset 缺少参数值');
      process.exit(1);
    }
    const parsed = Number(v);
    if (!Number.isFinite(parsed)) {
      console.error(`--offset 必须是数字，收到: ${v}`);
      process.exit(1);
    }
    offsetMinutes = parsed;
  }

  const config = await loadConfig();

  if (offsetMinutes === undefined) {
    // 自动错峰：N 个已有帐号 → 新帐号 offset = N * interval_minutes
    offsetMinutes = (config.accounts ?? []).length * config.interval_minutes;
  }

  let token;
  try {
    const raw = await prompt(`token (帐号 ${name}): `);
    token = raw.trim();
  } finally {
    closePrompt();
  }

  if (!token) {
    console.error('token 不能为空');
    process.exit(1);
  }

  let next;
  try {
    next = addAccount(config, { name, token, offsetMinutes });
  } catch (err) {
    console.error(`添加帐号失败: ${err.message}`);
    process.exit(1);
  }
  await saveConfig(next);

  console.log(`已添加帐号 "${name}" (offset_minutes=${offsetMinutes})`);
  console.log(`配置文件: ${getConfigPath()}`);
}
