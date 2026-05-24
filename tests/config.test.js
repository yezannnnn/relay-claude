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
  // v0.1 token 字段在 loadConfig 时被迁移为 legacy_token
  assert.equal(reloaded.interval_minutes, 90);
  assert.equal(reloaded.ping_prompt, 'hello');
  assert.deepEqual(reloaded.accounts, [
    { name: 'a', legacy_token: 'sk-ant-1', offset_minutes: 0 },
  ]);
  // v0.3 新增：loadConfig 注入 scheduler 默认值
  assert.ok(reloaded.scheduler);
  assert.equal(reloaded.scheduler.enabled, true);
  assert.equal(reloaded.scheduler.sub_weights.pro, 1);
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
  // v0.1 token 参数被存为 legacy_token
  assert.deepEqual(next.accounts[0], {
    name: 'primary',
    legacy_token: 'sk-ant-xxx',
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

test('addAccount accepts credentials shape (v0.2)', async () => {
  const { addAccount, loadConfig } = await freshModule();
  let cfg = await loadConfig();
  cfg = addAccount(cfg, {
    name: 'primary',
    credentials: {
      accessToken: 'sk-ant-oat01-x',
      refreshToken: 'sk-ant-ort01-y',
      expiresAt: 9999999999999,
      scopes: ['user:profile'],
      subscriptionType: 'pro',
    },
    offsetMinutes: 0,
  });
  assert.equal(cfg.accounts[0].credentials.accessToken, 'sk-ant-oat01-x');
  assert.equal(cfg.accounts[0].credentials.subscriptionType, 'pro');
});

test('loadConfig migrates v0.1 token field to legacy_token', async () => {
  const { loadConfig, getConfigDir, getConfigPath } = await freshModule();
  await fs.mkdir(getConfigDir(), { recursive: true });
  await fs.writeFile(
    getConfigPath(),
    JSON.stringify({
      interval_minutes: 100,
      ping_prompt: 'hi',
      accounts: [{ name: 'old', token: 'sk-ant-oat01-legacy', offset_minutes: 0 }],
    })
  );

  const cfg = await loadConfig();
  assert.equal(cfg.accounts[0].legacy_token, 'sk-ant-oat01-legacy');
  assert.equal(cfg.accounts[0].credentials, undefined);
  assert.equal(cfg.accounts[0].token, undefined);
});

test('getAccessToken returns credentials.accessToken or legacy_token', async () => {
  const { getAccessToken } = await freshModule();
  assert.equal(getAccessToken({ credentials: { accessToken: 'new' } }), 'new');
  assert.equal(getAccessToken({ legacy_token: 'old' }), 'old');
  assert.equal(getAccessToken({}), null);
  assert.equal(getAccessToken(null), null);
});

test('setCredentials updates account credentials and clears legacy_token', async () => {
  const { setCredentials } = await freshModule();
  let cfg = {
    interval_minutes: 100,
    accounts: [{ name: 'a', legacy_token: 'old', offset_minutes: 0 }],
  };
  cfg = setCredentials(cfg, 'a', {
    accessToken: 'new-at',
    refreshToken: 'new-rt',
    expiresAt: 999,
    scopes: ['user:profile'],
    subscriptionType: 'pro',
  });
  assert.equal(cfg.accounts[0].credentials.accessToken, 'new-at');
  assert.equal(cfg.accounts[0].legacy_token, undefined);
});

test('setLastUsage stores usage data on account', async () => {
  const { setLastUsage } = await freshModule();
  let cfg = {
    interval_minutes: 100,
    accounts: [{ name: 'a', credentials: { accessToken: 'x' }, offset_minutes: 0 }],
  };
  cfg = setLastUsage(cfg, 'a', {
    five_hour: { utilization: 0.57, resets_at: '2026-05-23T19:00:00Z' },
    seven_day: { utilization: 0.14, resets_at: '2026-05-28T15:00:00Z' },
    fetched_at: '2026-05-23T14:00:00Z',
  });
  assert.equal(cfg.accounts[0].last_usage.five_hour.utilization, 0.57);
});
