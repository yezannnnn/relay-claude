// scheduler.js 单元测试
// 所有测试使用固定时间，避免依赖 Date.now()

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPingTime,
  shouldPingNow,
  dueAccounts,
  estimatedRemainingMinutes,
  recommendedAccount,
} from '../src/scheduler.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const T0 = new Date('2026-05-23T09:00:00.000Z'); // 守护进程启动时间
const MIN = 60 * 1000;

/** 加分钟工具 */
function plusMin(date, minutes) {
  return new Date(date.getTime() + minutes * MIN);
}

/** 构造 3 帐号默认配置 */
function makeConfig3() {
  return {
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [
      { name: 'primary', token: 't1', offset_minutes: 0 },
      { name: 'secondary', token: 't2', offset_minutes: 100 },
      { name: 'tertiary', token: 't3', offset_minutes: 200 },
    ],
  };
}

/** 构造 2 帐号配置 */
function makeConfig2() {
  return {
    interval_minutes: 100,
    ping_prompt: 'hi',
    accounts: [
      { name: 'primary', token: 't1', offset_minutes: 0 },
      { name: 'secondary', token: 't2', offset_minutes: 100 },
    ],
  };
}

/** 构造默认 state（已启动，未 ping） */
function makeState(overrides = {}) {
  return {
    daemon_pid: 1234,
    started_at: T0.toISOString(),
    last_pings: {},
    ...overrides,
  };
}

// ─── nextPingTime ────────────────────────────────────────────────────────────

test('nextPingTime: 首次 ping primary (offset=0) = started_at', () => {
  const config = makeConfig3();
  const state = makeState();
  const next = nextPingTime(config.accounts[0], state, config, config.accounts);
  assert.equal(next.getTime(), T0.getTime());
});

test('nextPingTime: 首次 ping secondary (offset=100) = started_at + 100min', () => {
  const config = makeConfig3();
  const state = makeState();
  const next = nextPingTime(config.accounts[1], state, config, config.accounts);
  assert.equal(next.getTime(), plusMin(T0, 100).getTime());
});

test('nextPingTime: 首次 ping tertiary (offset=200) = started_at + 200min', () => {
  const config = makeConfig3();
  const state = makeState();
  const next = nextPingTime(config.accounts[2], state, config, config.accounts);
  assert.equal(next.getTime(), plusMin(T0, 200).getTime());
});

test('nextPingTime: primary 已 ping，3 帐号 → 下次 = last_ping + 300min', () => {
  const config = makeConfig3();
  const lastPing = plusMin(T0, 0).toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  const next = nextPingTime(config.accounts[0], state, config, config.accounts);
  assert.equal(next.getTime(), plusMin(new Date(lastPing), 300).getTime());
});

test('nextPingTime: secondary 已 ping，2 帐号 → 下次 = last_ping + 200min', () => {
  const config = makeConfig2();
  const lastPing = plusMin(T0, 100).toISOString();
  const state = makeState({ last_pings: { secondary: lastPing } });
  const next = nextPingTime(config.accounts[1], state, config, config.accounts);
  assert.equal(next.getTime(), plusMin(new Date(lastPing), 200).getTime());
});

// ─── shouldPingNow ───────────────────────────────────────────────────────────

test('shouldPingNow: 启动瞬间立即 ping primary (now == started_at) → true', () => {
  const config = makeConfig3();
  const state = makeState();
  const result = shouldPingNow(config.accounts[0], state, config, config.accounts, T0);
  assert.equal(result, true);
});

test('shouldPingNow: secondary 还没到时间 (now < offset) → false', () => {
  const config = makeConfig3();
  const state = makeState();
  // 启动 50 分钟后，secondary (offset=100) 还没到
  const now = plusMin(T0, 50);
  const result = shouldPingNow(config.accounts[1], state, config, config.accounts, now);
  assert.equal(result, false);
});

test('shouldPingNow: secondary 到时间了 (now == started_at + 100min) → true', () => {
  const config = makeConfig3();
  const state = makeState();
  const now = plusMin(T0, 100);
  const result = shouldPingNow(config.accounts[1], state, config, config.accounts, now);
  assert.equal(result, true);
});

test('shouldPingNow: primary 已 ping，未到下个周期 → false', () => {
  const config = makeConfig3();
  const lastPing = T0.toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  // 才过了 50 分钟，距离下次 300min 还远
  const now = plusMin(T0, 50);
  const result = shouldPingNow(config.accounts[0], state, config, config.accounts, now);
  assert.equal(result, false);
});

test('shouldPingNow: primary 已 ping，到了下个周期 → true', () => {
  const config = makeConfig3();
  const lastPing = T0.toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  const now = plusMin(T0, 300);
  const result = shouldPingNow(config.accounts[0], state, config, config.accounts, now);
  assert.equal(result, true);
});

// ─── dueAccounts ─────────────────────────────────────────────────────────────

test('dueAccounts: 启动瞬间只有 primary due', () => {
  const config = makeConfig3();
  const state = makeState();
  const due = dueAccounts(state, config, T0);
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'primary');
});

test('dueAccounts: 启动 100min 后 primary 已 ping，只有 secondary due', () => {
  const config = makeConfig3();
  const state = makeState({
    last_pings: { primary: T0.toISOString() },
  });
  const now = plusMin(T0, 100);
  const due = dueAccounts(state, config, now);
  assert.equal(due.length, 1);
  assert.equal(due[0].name, 'secondary');
});

test('dueAccounts: 启动 100min 后 primary 未 ping，primary + secondary 都 due（按 offset 排序）', () => {
  // 边界场景：守护进程错过了 primary 的 ping（崩溃等），现在两个都该 ping
  const config = makeConfig3();
  const state = makeState();
  const now = plusMin(T0, 100);
  const due = dueAccounts(state, config, now);
  assert.equal(due.length, 2);
  assert.equal(due[0].name, 'primary');   // offset=0 排前
  assert.equal(due[1].name, 'secondary'); // offset=100 排后
});

// ─── estimatedRemainingMinutes ───────────────────────────────────────────────

test('estimatedRemainingMinutes: 未 ping 过 → null', () => {
  const state = makeState();
  const account = { name: 'primary', offset_minutes: 0 };
  const remaining = estimatedRemainingMinutes(account, state, T0);
  assert.equal(remaining, null);
});

test('estimatedRemainingMinutes: 刚 ping 完 → 300 (5h)', () => {
  const account = { name: 'primary', offset_minutes: 0 };
  const lastPing = T0.toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  const remaining = estimatedRemainingMinutes(account, state, T0);
  assert.equal(remaining, 300);
});

test('estimatedRemainingMinutes: ping 60min 后 → 240', () => {
  const account = { name: 'primary', offset_minutes: 0 };
  const lastPing = T0.toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  const now = plusMin(T0, 60);
  const remaining = estimatedRemainingMinutes(account, state, now);
  assert.equal(remaining, 240);
});

test('estimatedRemainingMinutes: 已超过 5h → 0（不返回负数）', () => {
  const account = { name: 'primary', offset_minutes: 0 };
  const lastPing = T0.toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  const now = plusMin(T0, 400); // 超 5h * 60min
  const remaining = estimatedRemainingMinutes(account, state, now);
  assert.equal(remaining, 0);
});

// ─── recommendedAccount ──────────────────────────────────────────────────────

test('recommendedAccount: 全都没 ping → 返回 primary (offset 最小)', () => {
  const config = makeConfig3();
  const state = makeState();
  const rec = recommendedAccount(state, config, T0);
  assert.equal(rec.name, 'primary');
});

test('recommendedAccount: 只有 primary ping 过 → 返回 primary（其他剩余为 null 不参与比较）', () => {
  const config = makeConfig3();
  const lastPing = T0.toISOString();
  const state = makeState({ last_pings: { primary: lastPing } });
  // 5min 后查询
  const rec = recommendedAccount(state, config, plusMin(T0, 5));
  assert.equal(rec.name, 'primary');
});

test('recommendedAccount: primary 和 secondary 都 ping 过，secondary 更新鲜 → 返回 secondary', () => {
  const config = makeConfig3();
  const state = makeState({
    last_pings: {
      primary: T0.toISOString(),                 // 较早
      secondary: plusMin(T0, 100).toISOString(), // 较晚 → 剩余多
    },
  });
  // now = T0+150min
  const rec = recommendedAccount(state, config, plusMin(T0, 150));
  assert.equal(rec.name, 'secondary');
});

test('recommendedAccount: 帐号列表为空 → null', () => {
  const config = { interval_minutes: 100, ping_prompt: 'hi', accounts: [] };
  const state = makeState();
  const rec = recommendedAccount(state, config, T0);
  assert.equal(rec, null);
});
