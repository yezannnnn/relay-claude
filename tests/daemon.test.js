// daemon.js 单元测试
//
// 测试覆盖:
//   - runDaemon 主循环
//   - shouldStop 提前退出
//   - pingFn 注入和成功/失败处理
//   - last_pings 持久化
//   - 单帐号异常不影响其他帐号
//   - nowFn 时间注入

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function freshModule() {
  return await import('../src/daemon.js');
}

let tmpHome;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'idc-daemon-'));
  process.env.INTERVAL_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.INTERVAL_CLAUDE_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

const MIN = 60 * 1000; // 1 分钟毫秒

function plusMin(date, minutes) {
  return new Date(date.getTime() + minutes * MIN);
}

/** 保存测试配置 */
async function saveTestConfig(accounts) {
  const { saveConfig } = await import('../src/config.js');
  await saveConfig({
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts,
  });
}

/** 保存测试状态 */
async function saveTestState(daemon_pid, started_at, last_pings = {}) {
  const { saveState } = await import('../src/state.js');
  await saveState({
    daemon_pid,
    started_at,
    last_pings,
  });
}

// ─── Test Cases ──────────────────────────────────────────────────────────

test('runDaemon: shouldStop 立即返回 true → 0 次 ping 即退出', async () => {
  const config = [
    { name: 'primary', token: 't1', offset_minutes: 0 },
    { name: 'secondary', token: 't2', offset_minutes: 100 },
  ];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  let pingCount = 0;
  const { runDaemon } = await freshModule();

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    shouldStop: () => true,
    pingFn: async () => {
      pingCount++;
      return { success: true };
    },
    nowFn: () => T0,
  });

  // shouldStop 立即返回 true，主循环直接退出，ping 不应被调用
  assert.equal(pingCount, 0, '期望 0 次 ping，但实际被调用了');
});

test('runDaemon: mock pingFn 被调用至少 1 次', async () => {
  const config = [
    { name: 'primary', token: 't1', offset_minutes: 0 },
    { name: 'secondary', token: 't2', offset_minutes: 100 },
  ];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  // 启动 1 小时前 → 两个帐号都该 ping
  const startedAt = plusMin(T0, -60);
  await saveTestState(1234, startedAt.toISOString());

  let pingCount = 0;
  const { runDaemon } = await freshModule();

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    shouldStop: () => pingCount > 0, // 第一次 ping 后立即退出
    pingFn: async (account) => {
      pingCount++;
      return { success: true };
    },
    nowFn: () => T0,
  });

  assert.ok(pingCount >= 1, `期望 pingFn 至少被调用 1 次，但只被调用了 ${pingCount} 次`);
});

test('runDaemon: ping 成功后 last_pings 被写入', async () => {
  const config = [{ name: 'primary', token: 't1', offset_minutes: 0 }];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let pingDone = false;
  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    shouldStop: () => pingDone,
    pingFn: async () => {
      pingDone = true;
      return { success: true };
    },
    nowFn: () => T0,
  });

  // 检查 last_pings 是否被写入
  const { loadState } = await import('../src/state.js');
  const state = await loadState();
  assert.ok(
    state.last_pings.primary,
    'last_pings.primary 应该被写入，但为 ' + state.last_pings.primary
  );
});

test('runDaemon: ping 抛错时 daemon 不崩溃，且不写入 last_pings', async () => {
  // v0.3 调度器基于 health 选最优账户，不做轮询。
  // 本测试验证：调度器选中某账户后 pingFn 抛错，daemon 捕获并继续，
  // 不写入 last_pings，不崩溃整个进程。
  const config = [
    { name: 'primary', token: 't1', offset_minutes: 0 },
  ];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let pingDone = false;
  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    shouldStop: () => pingDone,
    pingFn: async (account) => {
      pingDone = true;
      throw new Error(`${account.name} ping failed intentionally`);
    },
    nowFn: () => T0,
  });

  // ping 失败 → last_pings 不应写入；daemon 不应崩溃（能跑到这里即证明）
  const { loadState } = await import('../src/state.js');
  const state = await loadState();
  assert.ok(
    !state.last_pings.primary,
    'ping 异常后 last_pings.primary 不应被写入，实际 = ' + state.last_pings.primary,
  );
});

test('runDaemon: 接收 nowFn 参数控制时间', async () => {
  const config = [{ name: 'primary', token: 't1', offset_minutes: 0 }];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let pingCount = 0;
  const FIXED_TIME = new Date('2026-05-23T10:00:00.000Z');

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    shouldStop: () => pingCount > 0,
    pingFn: async () => {
      pingCount++;
      return { success: true };
    },
    nowFn: () => FIXED_TIME, // 始终返回固定时间
  });

  assert.equal(pingCount, 1, '期望 pingFn 被调用 1 次');
});

test('runDaemon: 两轮循环中 shouldStop 在第一次 ping 后返回 true', async () => {
  const config = [{ name: 'primary', token: 't1', offset_minutes: 0 }];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let pingCount = 0;
  let logCount = 0;

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    logFn: () => {
      logCount++;
    },
    shouldStop: () => pingCount > 0, // 第一次 ping 后返回 true
    pingFn: async () => {
      pingCount++;
      return { success: true };
    },
    nowFn: () => T0,
  });

  // 应该只 ping 一次，然后直接退出（不再循环等待）
  assert.equal(pingCount, 1, '期望 pingFn 被调用 1 次');
});

test('runDaemon: logFn 被调用记录日志', async () => {
  const config = [{ name: 'primary', token: 't1', offset_minutes: 0 }];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let logCount = 0;
  const logs = [];

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    logFn: (msg) => {
      logs.push(msg);
      logCount++;
    },
    shouldStop: () => logCount >= 3, // 启动 + 1 次 ping + 退出 = 3 条日志
    pingFn: async () => {
      return { success: true };
    },
    nowFn: () => T0,
  });

  assert.ok(
    logs.some((l) => l.includes('启动')),
    '日志应该包含"启动"'
  );
  assert.ok(
    logs.some((l) => l.includes('primary')),
    '日志应该包含"primary"'
  );
  assert.ok(
    logs.some((l) => l.includes('退出')),
    '日志应该包含"退出"'
  );
});

test('runDaemon: ping 失败时 last_pings 不被写入', async () => {
  const config = [{ name: 'primary', token: 't1', offset_minutes: 0 }];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let pingDone = false;
  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    shouldStop: () => pingDone,
    pingFn: async () => {
      pingDone = true;
      return { success: false, lastResult: { code: 1 } }; // 失败
    },
    nowFn: () => T0,
  });

  const { loadState } = await import('../src/state.js');
  const state = await loadState();
  assert.strictEqual(
    state.last_pings.primary,
    undefined,
    'ping 失败后 last_pings.primary 应该保持未定义'
  );
});

test('runDaemon: 读取配置失败时继续循环不崩溃', async () => {
  // 不保存配置 → loadConfig 会返回默认配置（无帐号）
  // 预置状态但没配置 → 没有 due 帐号 → ping 不被调用

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  await saveTestState(1234, T0.toISOString());

  const { runDaemon } = await freshModule();

  let logCount = 0;
  let shouldStopCalls = 0;

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 50,
    logFn: () => {
      logCount++;
    },
    shouldStop: () => {
      shouldStopCalls++;
      return shouldStopCalls > 2; // 两轮后退出
    },
    pingFn: async () => {
      throw new Error('ping should not be called');
    },
    nowFn: () => T0,
  });

  // 应该没有错误抛出，主循环继续
  assert.ok(logCount >= 2, '应该有日志输出');
});

test('runDaemon: usage polling round-robin 轮询所有账户', async () => {
  // 4 个账户 + 4 轮循环 → 每个账户被查询一次
  const config = [
    {
      name: 'A',
      credentials: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 86400000, subscriptionType: 'pro' },
      offset_minutes: 0,
    },
    {
      name: 'B',
      credentials: { accessToken: 'b1', refreshToken: 'r2', expiresAt: Date.now() + 86400000, subscriptionType: 'pro' },
      offset_minutes: 0,
    },
    {
      name: 'C',
      credentials: { accessToken: 'c1', refreshToken: 'r3', expiresAt: Date.now() + 86400000, subscriptionType: 'pro' },
      offset_minutes: 0,
    },
    {
      name: 'D',
      credentials: { accessToken: 'd1', refreshToken: 'r4', expiresAt: Date.now() + 86400000, subscriptionType: 'pro' },
      offset_minutes: 0,
    },
  ];
  await saveTestConfig(config);

  const polled = [];
  const { runDaemon } = await freshModule();

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 5,
    // 直接按 poll 次数停止：shouldStop 在每次迭代内被调用 3-4 次，
    // 用 cycle 计数会提前触发，改为等 4 个账户全部轮询完再退出
    shouldStop: () => polled.length >= 4,
    useAccountFn: async () => {},
    queryUsageWithRefreshFn: async (creds) => {
      polled.push(creds.accessToken);
      return {
        usage: {
          five_hour: { utilization: 0.1, resets_at: new Date(Date.now() + 5 * 3600 * 1000).toISOString() },
          seven_day: { utilization: 0.05, resets_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString() },
          fetched_at: new Date().toISOString(),
        },
        credentials: creds,
      };
    },
    pingFn: async () => ({ success: false }),
  });

  // 4 轮应该轮询过 4 个账户（顺序：a1, b1, c1, d1）
  assert.deepEqual(polled, ['a1', 'b1', 'c1', 'd1'], 'round-robin 应该按配置顺序轮询每个账户一次');
});

test('runDaemon: usage polling 跳过 7D 已满账户', async () => {
  const config = [
    {
      name: 'A',
      credentials: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 86400000, subscriptionType: 'pro' },
      last_usage: {
        seven_day: { utilization: 1.0, resets_at: new Date(Date.now() + 3600000).toISOString() }, // 7D 满了
      },
      offset_minutes: 0,
    },
    {
      name: 'B',
      credentials: { accessToken: 'b1', refreshToken: 'r2', expiresAt: Date.now() + 86400000, subscriptionType: 'pro' },
      offset_minutes: 0,
    },
  ];
  await saveTestConfig(config);

  const polled = [];
  const { runDaemon } = await freshModule();

  await runDaemon({
    keychainSupportedFn: () => false,
    checkIntervalMs: 5,
    shouldStop: () => polled.length >= 2,
    useAccountFn: async () => {},
    queryUsageWithRefreshFn: async (creds) => {
      polled.push(creds.accessToken);
      return {
        usage: { five_hour: { utilization: 0.1, resets_at: new Date(Date.now() + 5 * 3600 * 1000).toISOString() } },
        credentials: creds,
      };
    },
    pingFn: async () => ({ success: false }),
  });

  // A 应该被跳过（7D 满），只有 B 被反复查询
  assert.ok(polled.every((t) => t === 'b1'), `应该只查询 B，实际：${polled.join(',')}`);
  assert.ok(polled.length >= 2, '至少查询 B 两次');
});

// ─── accountUuid 自愈匹配 ────────────────────────────────────────────────

test('runDaemon: token 都对不上时用 account_uuid 匹配，并把新 credentials 写回 config', async () => {
  const futureExp = Date.now() + 8 * 3600 * 1000;
  const config = [{
    name: 'A',
    account_uuid: 'uuid-A',
    credentials: { accessToken: 'OLD_AT', refreshToken: 'OLD_RT', expiresAt: futureExp, subscriptionType: 'pro' },
    offset_minutes: 0,
  }];
  await saveTestConfig(config);

  const keychainCreds = { accessToken: 'NEW_AT', refreshToken: 'NEW_RT', expiresAt: futureExp, scopes: [], subscriptionType: 'pro' };
  let profileCalls = 0;

  const { runDaemon } = await freshModule();
  let loops = 0;
  await runDaemon({
    keychainSupportedFn: () => true,
    readKeychainRawFn: () => JSON.stringify({ claudeAiOauth: keychainCreds }),
    queryProfileFn: async (tok) => {
      profileCalls++;
      assert.equal(tok, 'NEW_AT');
      return { email: 'a@x.com', accountUuid: 'uuid-A' };
    },
    queryUsageWithRefreshFn: async () => ({ usage: null, credentials: keychainCreds }),
    useAccountFn: async () => {},
    pingFn: async () => ({ success: true }),
    checkIntervalMs: 5,
    shouldStop: () => ++loops >= 2,
  });

  // 验证 config 已被 self-heal：accessToken 应该被改成 keychain 当前的 NEW_AT
  const { loadConfig } = await import('../src/config.js');
  const cfg = await loadConfig();
  assert.equal(cfg.accounts[0].credentials.accessToken, 'NEW_AT', 'self-heal 应该把新 token 写回 config');
  assert.equal(cfg.accounts[0].credentials.refreshToken, 'NEW_RT');
  // profile 只该被查 1 次（第二次走 cache）
  assert.equal(profileCalls, 1, `profile 应该只被查 1 次（cache 命中），实际 ${profileCalls} 次`);
});

test('runDaemon: account_uuid 不匹配任何 config 账户 → keychainUnknown 暂停调度', async () => {
  const futureExp = Date.now() + 8 * 3600 * 1000;
  const config = [{
    name: 'A',
    account_uuid: 'uuid-A',
    credentials: { accessToken: 'A_AT', refreshToken: 'A_RT', expiresAt: futureExp, subscriptionType: 'pro' },
    offset_minutes: 0,
  }];
  await saveTestConfig(config);

  const externalCreds = { accessToken: 'EXTERNAL_AT', refreshToken: 'EXTERNAL_RT', expiresAt: futureExp };
  let pingCount = 0;
  let profileCalls = 0;

  const { runDaemon } = await freshModule();
  let loops = 0;
  await runDaemon({
    keychainSupportedFn: () => true,
    readKeychainRawFn: () => JSON.stringify({ claudeAiOauth: externalCreds }),
    queryProfileFn: async () => { profileCalls++; return { accountUuid: 'uuid-EXTERNAL' }; },
    useAccountFn: async () => {},
    pingFn: async () => { pingCount++; return { success: true }; },
    checkIntervalMs: 5,
    shouldStop: () => ++loops >= 2,
  });

  // pingFn 不应被调用（keychainUnknown 暂停）
  assert.equal(pingCount, 0, 'keychainUnknown 应该暂停调度，pingFn 不该被调用');
  // profile 只该被查 1 次（第二次因 cache=false 跳过）
  assert.equal(profileCalls, 1);
});
