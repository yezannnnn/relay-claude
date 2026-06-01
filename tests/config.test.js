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

test('updateConfig: 原子读改写，updater 收到当前最新 config', async () => {
  const { saveConfig, updateConfig, setLastUsage } = await freshModule();
  await saveConfig({
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [
      { name: 'A', credentials: { accessToken: 'aa' }, offset_minutes: 0 },
    ],
  });
  const result = await updateConfig((cfg) => {
    assert.equal(cfg.accounts[0].name, 'A', 'updater 应该看到最新 config');
    return setLastUsage(cfg, 'A', {
      five_hour: { utilization: 0.3, resets_at: '2026-05-23T19:00:00Z' },
    });
  });
  assert.equal(result.accounts[0].last_usage.five_hour.utilization, 0.3);
});

test('updateConfig: 串行调用，第二次 updater 看到第一次的结果', async () => {
  const { saveConfig, updateConfig, loadConfig, setLastUsage } = await freshModule();
  await saveConfig({
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [
      { name: 'A', credentials: { accessToken: 'aa' }, offset_minutes: 0 },
    ],
  });
  // 第一次更新写入 utilization=0.2
  await updateConfig((cfg) =>
    setLastUsage(cfg, 'A', {
      five_hour: { utilization: 0.2, resets_at: '2026-05-23T19:00:00Z' },
    }),
  );
  // 第二次更新基于第一次结果再 patch
  await updateConfig((cfg) => {
    assert.equal(
      cfg.accounts[0].last_usage.five_hour.utilization,
      0.2,
      '第二次 updater 应看到第一次的结果',
    );
    return setLastUsage(cfg, 'A', {
      five_hour: { utilization: 0.5, resets_at: '2026-05-23T19:00:00Z' },
    });
  });
  const after = await loadConfig();
  assert.equal(after.accounts[0].last_usage.five_hour.utilization, 0.5);
});

test('updateConfig: updater 返回非对象抛错', async () => {
  const { saveConfig, updateConfig } = await freshModule();
  await saveConfig({ interval_minutes: 100, ping_prompt: 'hi', accounts: [] });
  await assert.rejects(
    () => updateConfig(() => null),
    /必须返回新 config 对象/,
  );
});

test('updateConfig: 非函数 updater 抛错', async () => {
  const { updateConfig } = await freshModule();
  await assert.rejects(() => updateConfig('not a function'), /必须是函数/);
});

test('updateConfig: 并发写入串行化，两个账户的修改都保留', async () => {
  const { saveConfig, updateConfig, loadConfig, setLastUsage } = await freshModule();
  await saveConfig({
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [
      { name: 'A', credentials: { accessToken: 'aa' }, offset_minutes: 0 },
      { name: 'B', credentials: { accessToken: 'bb' }, offset_minutes: 0 },
    ],
  });

  // 并发调用 — 无锁时后写者会覆盖前写者对另一账户的修改
  await Promise.all([
    updateConfig((cfg) => setLastUsage(cfg, 'A', { five_hour: { utilization: 0.3 } })),
    updateConfig((cfg) => setLastUsage(cfg, 'B', { five_hour: { utilization: 0.7 } })),
  ]);

  const final = await loadConfig();
  const aAcc = final.accounts.find((a) => a.name === 'A');
  const bAcc = final.accounts.find((a) => a.name === 'B');
  assert.equal(aAcc?.last_usage?.five_hour?.utilization, 0.3, 'A 的更新应被保留');
  assert.equal(bAcc?.last_usage?.five_hour?.utilization, 0.7, 'B 的更新应被保留');
});

test('updateConfig: 过期锁文件自动清理后正常执行', async () => {
  const { saveConfig, updateConfig } = await freshModule();
  await saveConfig({ interval_minutes: 100, ping_prompt: 'hi', accounts: [] });

  // 写入一个过期锁文件（mtime 设为 20 秒前，超过 LOCK_STALE_MS=15s）
  const lockPath = path.join(tmpHome, 'config.lock');
  await fs.writeFile(lockPath, '99999');
  const staleTime = new Date(Date.now() - 20000);
  await fs.utimes(lockPath, staleTime, staleTime);

  // 应自动清理过期锁并成功执行
  const result = await updateConfig((cfg) => ({ ...cfg, ping_prompt: 'cleaned' }));
  assert.equal(result.ping_prompt, 'cleaned');

  // 锁文件执行后应被清理
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' }, '锁文件应在完成后被删除');
});
