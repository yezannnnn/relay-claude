// pinger.js 单元测试
//
// 用 mock spawn 避免真正调起 claude CLI。
// mock 子进程基于 EventEmitter + 两个独立的 stdout/stderr emitter。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  pingAccount,
  pingWithRetry,
  pingAll,
} from '../src/pinger.js';

/**
 * 构造可控的 mock spawn 函数。
 *
 * @param {{
 *   exitCode?: number,
 *   stdout?: string | string[],
 *   stderr?: string | string[],
 *   delayMs?: number,
 *   timeout?: boolean,    // true → 模拟超时（永不 exit，需要外部 kill）
 *   spawnThrow?: Error,   // spawn 调用本身抛错
 * }} [behavior]
 * @returns {{spawnFn: Function, calls: Array}}
 */
function makeMockSpawn(behavior = {}) {
  const calls = [];

  const spawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });

    if (behavior.spawnThrow) {
      throw behavior.spawnThrow;
    }

    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = (signal) => {
      child.killed = true;
      // 模拟被 kill 后子进程退出
      setImmediate(() => {
        child.emit('exit', null, signal || 'SIGTERM');
      });
      return true;
    };

    const delay = behavior.delayMs ?? 0;

    setTimeout(() => {
      const stdoutChunks = Array.isArray(behavior.stdout)
        ? behavior.stdout
        : behavior.stdout
        ? [behavior.stdout]
        : [];
      const stderrChunks = Array.isArray(behavior.stderr)
        ? behavior.stderr
        : behavior.stderr
        ? [behavior.stderr]
        : [];

      for (const chunk of stdoutChunks) {
        child.stdout.emit('data', Buffer.from(chunk));
      }
      for (const chunk of stderrChunks) {
        child.stderr.emit('data', Buffer.from(chunk));
      }

      if (behavior.timeout) {
        // 不 emit exit → 等 pingAccount 的 manual timer 把它 kill 掉
        return;
      }

      child.emit('exit', behavior.exitCode ?? 0, null);
    }, delay);

    return child;
  };

  return { spawnFn, calls };
}

/**
 * 可注入的 fake sleep — 立即 resolve 并记录调用，避免测试等待。
 */
function makeFakeSleep() {
  const delays = [];
  const sleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleepFn, delays };
}

const FAKE_ACCOUNT = Object.freeze({
  name: 'acct-a',
  legacy_token: 'sk-test-token-aaa',
  offset_minutes: 0,
});

// ---------- pingAccount ----------

test('pingAccount: 成功 ping 返回 success=true 和 code=0', async () => {
  const { spawnFn } = makeMockSpawn({ exitCode: 0, stdout: 'ok' });

  const result = await pingAccount(FAKE_ACCOUNT, 'hi', { spawnFn });

  assert.equal(result.success, true);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, '');
  assert.equal(typeof result.durationMs, 'number');
});

test('pingAccount: 失败 ping 返回 success=false 和 code=1', async () => {
  const { spawnFn } = makeMockSpawn({
    exitCode: 1,
    stderr: 'auth failed',
  });

  const result = await pingAccount(FAKE_ACCOUNT, 'hi', { spawnFn });

  assert.equal(result.success, false);
  assert.equal(result.code, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.stderr, 'auth failed');
});

test('pingAccount: 超时返回 timedOut=true 且 success=false', async () => {
  const { spawnFn } = makeMockSpawn({ timeout: true });

  const result = await pingAccount(FAKE_ACCOUNT, 'hi', {
    spawnFn,
    timeoutMs: 100, // 短超时加快测试
  });

  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
});

test('pingAccount: CLAUDE_CODE_OAUTH_TOKEN 通过 env 传给子进程', async () => {
  const { spawnFn, calls } = makeMockSpawn({ exitCode: 0 });

  await pingAccount(FAKE_ACCOUNT, 'hi', { spawnFn });

  assert.equal(calls.length, 1);
  const env = calls[0].options.env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_ACCOUNT.legacy_token);
  // 同时应包含原有 env 的内容（合并而非替换）
  assert.equal(env.PATH, process.env.PATH);
});

test('pingAccount: 不污染 process.env.CLAUDE_CODE_OAUTH_TOKEN', async () => {
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // 确保测试环境干净
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const { spawnFn } = makeMockSpawn({ exitCode: 0 });
  await pingAccount(FAKE_ACCOUNT, 'hi', { spawnFn });

  assert.equal(
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
    undefined,
    'ping 后 process.env 不应被设置',
  );

  // 恢复原值
  if (before !== undefined) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
  }
});

test('pingAccount: stdout 多 chunk 拼接成完整字符串', async () => {
  const { spawnFn } = makeMockSpawn({
    exitCode: 0,
    stdout: ['hello ', 'world', '!'],
    stderr: ['warn1\n', 'warn2\n'],
  });

  const result = await pingAccount(FAKE_ACCOUNT, 'hi', { spawnFn });

  assert.equal(result.stdout, 'hello world!');
  assert.equal(result.stderr, 'warn1\nwarn2\n');
});

test('pingAccount: spawn 调用使用的命令和参数正确', async () => {
  const { spawnFn, calls } = makeMockSpawn({ exitCode: 0 });

  await pingAccount(FAKE_ACCOUNT, 'custom prompt', {
    spawnFn,
    claudeBin: '/usr/local/bin/claude',
  });

  assert.equal(calls[0].cmd, '/usr/local/bin/claude');
  assert.deepEqual(calls[0].args, ['-p', 'custom prompt']);
});

test('pingAccount: 缺失 token 抛错', async () => {
  await assert.rejects(
    () => pingAccount({ name: 'x' }, 'hi', { spawnFn: () => {} }),
    /no token available/i,
  );
});

// ---------- pingWithRetry ----------

test('pingWithRetry: 前两次失败、第三次成功 → attempts=3 success=true', async () => {
  let callCount = 0;

  // 自定义 spawnFn 让前两次返回 exitCode=1，第三次返回 0
  const spawnFn = (cmd, args, options) => {
    callCount += 1;
    const exitCode = callCount < 3 ? 1 : 0;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {};
    setImmediate(() => child.emit('exit', exitCode, null));
    return child;
  };

  const { sleepFn, delays } = makeFakeSleep();

  const result = await pingWithRetry(FAKE_ACCOUNT, 'hi', {
    spawnFn,
    sleepFn,
    maxRetries: 3,
    baseDelayMs: 1000,
  });

  assert.equal(result.success, true);
  assert.equal(result.attempts, 3);
  assert.equal(callCount, 3);
  // 退避序列：1000, 2000（成功时第三次不会再 sleep）
  assert.deepEqual(delays, [1000, 2000]);
});

test('pingWithRetry: 全部失败 → success=false attempts=maxRetries', async () => {
  const { spawnFn } = makeMockSpawn({ exitCode: 1, stderr: 'fail' });
  const { sleepFn, delays } = makeFakeSleep();

  const result = await pingWithRetry(FAKE_ACCOUNT, 'hi', {
    spawnFn,
    sleepFn,
    maxRetries: 3,
    baseDelayMs: 500,
  });

  assert.equal(result.success, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.results.length, 3);
  // 全部失败时只在 attempts < maxRetries 时 sleep，所以 sleep 调用 2 次
  assert.deepEqual(delays, [500, 1000]);
});

test('pingWithRetry: 第一次成功 → 不重试不 sleep', async () => {
  const { spawnFn } = makeMockSpawn({ exitCode: 0 });
  const { sleepFn, delays } = makeFakeSleep();

  const result = await pingWithRetry(FAKE_ACCOUNT, 'hi', {
    spawnFn,
    sleepFn,
    maxRetries: 3,
  });

  assert.equal(result.success, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(delays, []);
});

// ---------- pingAll ----------

test('pingAll: 顺序执行，spawn 调用顺序与 accounts 顺序一致', async () => {
  const { spawnFn, calls } = makeMockSpawn({ exitCode: 0 });

  const accounts = [
    { name: 'a', legacy_token: 'tk-a' },
    { name: 'b', legacy_token: 'tk-b' },
    { name: 'c', legacy_token: 'tk-c' },
  ];

  const results = await pingAll(accounts, 'hi', { spawnFn });

  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => r.account),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    calls.map((c) => c.options.env.CLAUDE_CODE_OAUTH_TOKEN),
    ['tk-a', 'tk-b', 'tk-c'],
  );
  for (const r of results) {
    assert.equal(r.result.success, true);
  }
});

test('pingAll: 单个帐号失败不中断后续 ping', async () => {
  let callCount = 0;
  // 第二个帐号失败，第一/第三成功
  const spawnFn = (cmd, args, options) => {
    callCount += 1;
    const exitCode = callCount === 2 ? 1 : 0;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {};
    setImmediate(() => child.emit('exit', exitCode, null));
    return child;
  };

  const accounts = [
    { name: 'a', legacy_token: 'tk-a' },
    { name: 'b', legacy_token: 'tk-b' },
    { name: 'c', legacy_token: 'tk-c' },
  ];

  const results = await pingAll(accounts, 'hi', { spawnFn });

  assert.equal(results.length, 3);
  assert.equal(results[0].result.success, true);
  assert.equal(results[1].result.success, false);
  assert.equal(results[2].result.success, true);
});

test('pingAll: withRetry=true 时单帐号走重试逻辑', async () => {
  let callCount = 0;
  const spawnFn = (cmd, args, options) => {
    callCount += 1;
    // 帐号 a 第1次失败、第2次成功；帐号 b 第1次直接成功
    // 调用顺序：a-1(fail), a-2(ok), b-1(ok)
    const exitCode = callCount === 1 ? 1 : 0;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {};
    setImmediate(() => child.emit('exit', exitCode, null));
    return child;
  };

  const { sleepFn } = makeFakeSleep();

  const accounts = [
    { name: 'a', legacy_token: 'tk-a' },
    { name: 'b', legacy_token: 'tk-b' },
  ];

  const results = await pingAll(accounts, 'hi', {
    spawnFn,
    sleepFn,
    withRetry: true,
    maxRetries: 3,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].result.success, true);
  assert.equal(results[0].result.attempts, 2);
  assert.equal(results[1].result.success, true);
  assert.equal(results[1].result.attempts, 1);
  assert.equal(callCount, 3);
});

test('pingAll: accounts 非数组抛错', async () => {
  await assert.rejects(
    () => pingAll('not-an-array', 'hi', { spawnFn: () => {} }),
    /accounts 必须为数组/,
  );
});

// ---------- getAccessToken 集成测试 ----------

test('pingAccount uses credentials.accessToken when present', async () => {
  let capturedEnv;
  const mockSpawn = (cmd, args, options) => {
    capturedEnv = options.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit('exit', 0, null), 10);
    return child;
  };
  await pingAccount(
    { name: 'a', credentials: { accessToken: 'new-token' } },
    'hi',
    { spawnFn: mockSpawn },
  );
  assert.equal(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN, 'new-token');
});

test('pingAccount falls back to legacy_token for v0.1 accounts', async () => {
  let capturedEnv;
  const mockSpawn = (cmd, args, options) => {
    capturedEnv = options.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit('exit', 0, null), 10);
    return child;
  };
  await pingAccount(
    { name: 'a', legacy_token: 'old-token' },
    'hi',
    { spawnFn: mockSpawn },
  );
  assert.equal(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN, 'old-token');
});

test('pingAccount throws when no token available', async () => {
  await assert.rejects(
    pingAccount({ name: 'a' }, 'hi', { spawnFn: () => ({}) }),
    /no token|missing token|token/i,
  );
});
