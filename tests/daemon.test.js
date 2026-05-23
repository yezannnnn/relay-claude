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

test('runDaemon: 单帐号 ping 失败不影响其他帐号', async () => {
  const config = [
    { name: 'primary', token: 't1', offset_minutes: 0 },
    { name: 'secondary', token: 't2', offset_minutes: 100 },
    { name: 'tertiary', token: 't3', offset_minutes: 200 },
  ];
  await saveTestConfig(config);

  const T0 = new Date('2026-05-23T09:00:00.000Z');
  // 启动很久前 → 三个帐号都该 ping
  const startedAt = plusMin(T0, -300);
  await saveTestState(1234, startedAt.toISOString());

  const pingResults = {};
  const { runDaemon } = await freshModule();

  let callCount = 0;
  await runDaemon({
    checkIntervalMs: 50,
    shouldStop: () => callCount >= 3, // 三个帐号都 ping 后退出
    pingFn: async (account) => {
      callCount++;
      pingResults[account.name] = callCount;

      // secondary 抛错，其他成功
      if (account.name === 'secondary') {
        throw new Error('secondary ping failed');
      }
      return { success: true };
    },
    nowFn: () => T0,
  });

  // 检查 last_pings：primary 和 tertiary 应该有，secondary 应该没有
  const { loadState } = await import('../src/state.js');
  const state = await loadState();
  assert.ok(
    state.last_pings.primary,
    'primary 应该被 ping 成功，但 last_pings.primary = ' +
      state.last_pings.primary
  );
  assert.ok(
    !state.last_pings.secondary,
    'secondary 应该 ping 失败，但 last_pings.secondary = ' +
      state.last_pings.secondary
  );
  assert.ok(
    state.last_pings.tertiary,
    'tertiary 应该被 ping 成功，但 last_pings.tertiary = ' +
      state.last_pings.tertiary
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
