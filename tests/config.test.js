// config.js 单元测试
// 用临时目录 + 环境变量 INTERVAL_CLAUDE_HOME 做测试隔离

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 动态 import：保证每个测试都能在切换 env 之后再读模块
async function freshModule() {
  // ESM 没有 cache 失效 API，但 config.js 没有顶层副作用，
  // 所有路径都靠 getConfigDir() 实时读 env，因此一次 import 即可。
  return await import('../src/config.js');
}

let tmpHome;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'interval-claude-cfg-'));
  process.env.INTERVAL_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.INTERVAL_CLAUDE_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('loadConfig: 文件不存在时返回默认空配置', async () => {
  const { loadConfig } = await freshModule();
  const cfg = await loadConfig();
  assert.equal(cfg.interval_minutes, 100);
  assert.equal(cfg.ping_prompt, 'hi');
  assert.deepEqual(cfg.accounts, []);
});

test('saveConfig + loadConfig: 保存后能再读出来', async () => {
  const { loadConfig, saveConfig } = await freshModule();
  const cfg = {
    interval_minutes: 90,
    ping_prompt: 'hello',
    accounts: [{ name: 'a', token: 'sk-ant-1', offset_minutes: 0 }],
  };
  await saveConfig(cfg);

  const reloaded = await loadConfig();
  assert.deepEqual(reloaded, cfg);
});

test('saveConfig: 目录不存在时自动创建', async () => {
  const { saveConfig, getConfigDir, getConfigPath } = await freshModule();
  // tmpHome 本身存在，但 saveConfig 不应依赖目录结构由测试预创建
  // 这里手动删除再 save 验证
  await fs.rm(tmpHome, { recursive: true, force: true });

  await saveConfig({
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [],
  });

  const stat = await fs.stat(getConfigDir());
  assert.ok(stat.isDirectory(), '配置目录应被自动创建');
  const fileStat = await fs.stat(getConfigPath());
  assert.ok(fileStat.isFile(), 'config.json 应存在');
});

test('addAccount: 添加新帐号', async () => {
  const { addAccount } = await freshModule();
  const cfg = { interval_minutes: 100, ping_prompt: 'hi', accounts: [] };
  const next = addAccount(cfg, {
    name: 'primary',
    token: 'sk-ant-xxx',
    offsetMinutes: 0,
  });
  assert.equal(next.accounts.length, 1);
  assert.deepEqual(next.accounts[0], {
    name: 'primary',
    token: 'sk-ant-xxx',
    offset_minutes: 0,
  });
  // 纯函数：原 config 不变
  assert.equal(cfg.accounts.length, 0);
});

test('addAccount: 重名抛错', async () => {
  const { addAccount } = await freshModule();
  const cfg = {
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [{ name: 'primary', token: 't', offset_minutes: 0 }],
  };
  assert.throws(
    () =>
      addAccount(cfg, {
        name: 'primary',
        token: 'other',
        offsetMinutes: 100,
      }),
    /已存在/
  );
});

test('removeAccount: 移除帐号', async () => {
  const { removeAccount } = await freshModule();
  const cfg = {
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [
      { name: 'a', token: '1', offset_minutes: 0 },
      { name: 'b', token: '2', offset_minutes: 100 },
    ],
  };
  const next = removeAccount(cfg, 'a');
  assert.equal(next.accounts.length, 1);
  assert.equal(next.accounts[0].name, 'b');
  // 不存在的帐号：静默返回
  const noop = removeAccount(cfg, 'nonexistent');
  assert.equal(noop.accounts.length, 2);
});

test('findAccount: 找得到 / 找不到', async () => {
  const { findAccount } = await freshModule();
  const cfg = {
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [{ name: 'a', token: '1', offset_minutes: 0 }],
  };
  assert.deepEqual(findAccount(cfg, 'a'), {
    name: 'a',
    token: '1',
    offset_minutes: 0,
  });
  assert.equal(findAccount(cfg, 'nope'), undefined);
});

test('saveConfig: 文件权限 0o600 (Unix-only)', { skip: process.platform === 'win32' }, async () => {
  const { saveConfig, getConfigPath } = await freshModule();
  await saveConfig({ interval_minutes: 100, ping_prompt: 'hi', accounts: [] });
  const stat = await fs.stat(getConfigPath());
  // 取低 9 位 mode bits
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
});

test('loadConfig: 损坏的 JSON 抛错', async () => {
  const { loadConfig, getConfigPath, getConfigDir } = await freshModule();
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(getConfigPath(), 'not-json{');
  await assert.rejects(() => loadConfig(), /配置文件损坏/);
});
