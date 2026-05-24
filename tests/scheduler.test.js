// scheduler.js v0.3 单元测试
//
// 覆盖：health 公式各分支、needsSwitch、bestSwitchCandidate、shouldPrePing、schedule。
// 所有测试用固定时间，避免依赖 Date.now()。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  health,
  needsSwitch,
  bestSwitchCandidate,
  shouldPrePing,
  schedule,
  DEFAULT_SUB_WEIGHTS,
  ACTION_PING,
  ACTION_USE,
} from '../src/scheduler.js';

const T0 = new Date('2026-05-24T09:00:00.000Z').getTime();

function mkAccount({
  name,
  sub = 'pro',
  usage = null,
  resetsAt = null,
  windowStart = null,
  limitReachedAt = null,
}) {
  const a = { name, offset_minutes: 0 };
  if (sub) {
    a.credentials = { subscriptionType: sub, accessToken: `tok-${name}` };
  }
  if (usage != null || resetsAt) {
    a.last_usage = {
      five_hour: {
        utilization: usage ?? 0,
        resets_at: resetsAt,
      },
    };
  }
  if (windowStart) a.window_start = windowStart;
  if (limitReachedAt) a.limit_reached_at = limitReachedAt;
  return a;
}

function mkCfg(overrides = {}) {
  return {
    scheduler: {
      sub_weights: DEFAULT_SUB_WEIGHTS,
      expire_threshold_min: 3,
      stagger_min: null, // 自动 300/N
      ...overrides,
    },
  };
}

// === health() ===

test('health: 未激活 (Pro) → 1 × 300 = 300', () => {
  const a = mkAccount({ name: 'a', sub: 'pro' });
  assert.equal(health(a, mkCfg(), T0), 300);
});

test('health: 未激活 (max_5x) → 5 × 300 = 1500', () => {
  const a = mkAccount({ name: 'a', sub: 'max_5x' });
  assert.equal(health(a, mkCfg(), T0), 1500);
});

test('health: 未激活 (max_20x) → 20 × 300 = 6000', () => {
  const a = mkAccount({ name: 'a', sub: 'max_20x' });
  assert.equal(health(a, mkCfg(), T0), 6000);
});

test('health: 耗尽 → 0', () => {
  const a = mkAccount({
    name: 'a',
    sub: 'pro',
    usage: 1.0,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(health(a, mkCfg(), T0), 0);
});

test('health: 即将过期 (<3min) → 0', () => {
  const a = mkAccount({
    name: 'a',
    sub: 'pro',
    usage: 0.5,
    resetsAt: new Date(T0 + 2 * 60 * 1000).toISOString(),
  });
  assert.equal(health(a, mkCfg(), T0), 0);
});

test('health: 窗口已过期 → 视为未激活 (满血)', () => {
  const a = mkAccount({
    name: 'a',
    sub: 'pro',
    usage: 0.5,
    resetsAt: new Date(T0 - 60 * 60 * 1000).toISOString(),
  });
  assert.equal(health(a, mkCfg(), T0), 300);
});

test('health: 活跃中 (Pro, usage=0.5, 剩 60min) → 1 × 0.5 × 60 = 30', () => {
  const a = mkAccount({
    name: 'a',
    sub: 'pro',
    usage: 0.5,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(health(a, mkCfg(), T0), 30);
});

test('health: 活跃中 (max_5x, usage=0.2, 剩 240min) → 5 × 0.8 × 240 = 960', () => {
  const a = mkAccount({
    name: 'a',
    sub: 'max_5x',
    usage: 0.2,
    resetsAt: new Date(T0 + 240 * 60 * 1000).toISOString(),
  });
  assert.equal(health(a, mkCfg(), T0), 960);
});

test('health: 未知 sub → _default 权重 (1)', () => {
  const a = mkAccount({ name: 'a', sub: 'enterprise_xx' });
  assert.equal(health(a, mkCfg(), T0), 300); // 1 × 300
});

// === needsSwitch() ===

test('needsSwitch: active=null → true', () => {
  assert.equal(needsSwitch(null, mkCfg(), T0), true);
});

test('needsSwitch: usage 100% → true', () => {
  const a = mkAccount({
    name: 'a',
    usage: 1.0,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(needsSwitch(a, mkCfg(), T0), true);
});

test('needsSwitch: 窗口过期 → true', () => {
  const a = mkAccount({
    name: 'a',
    usage: 0.3,
    resetsAt: new Date(T0 - 60 * 1000).toISOString(),
  });
  assert.equal(needsSwitch(a, mkCfg(), T0), true);
});

test('needsSwitch: limit_reached 最近 10min → true', () => {
  const a = mkAccount({
    name: 'a',
    usage: 0.5,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    limitReachedAt: T0 - 5 * 60 * 1000,
  });
  assert.equal(needsSwitch(a, mkCfg(), T0), true);
});

test('needsSwitch: limit_reached 超过 10min → false (过期标记)', () => {
  const a = mkAccount({
    name: 'a',
    usage: 0.3,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    limitReachedAt: T0 - 15 * 60 * 1000,
  });
  assert.equal(needsSwitch(a, mkCfg(), T0), false);
});

test('needsSwitch: 健康正常 → false', () => {
  const a = mkAccount({
    name: 'a',
    usage: 0.3,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  assert.equal(needsSwitch(a, mkCfg(), T0), false);
});

// === bestSwitchCandidate() ===

test('bestSwitchCandidate: 排除自己 + 选健康度最高', () => {
  const accounts = [
    mkAccount({ name: 'A', sub: 'pro' }), // 未激活 → 300
    mkAccount({ name: 'B', sub: 'max_5x' }), // 未激活 → 1500
    mkAccount({
      name: 'C',
      sub: 'pro',
      usage: 1.0,
      resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    }), // 耗尽 → 0
  ];
  const result = bestSwitchCandidate(accounts, accounts[2], mkCfg(), T0);
  assert.equal(result.name, 'B');
});

test('bestSwitchCandidate: 全耗尽 → null', () => {
  const accounts = [
    mkAccount({
      name: 'A',
      usage: 1.0,
      resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    }),
    mkAccount({
      name: 'B',
      usage: 1.0,
      resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    }),
  ];
  const result = bestSwitchCandidate(accounts, accounts[0], mkCfg(), T0);
  assert.equal(result, null);
});

test('bestSwitchCandidate: exclude=null → 包含所有有效帐号', () => {
  const accounts = [
    mkAccount({ name: 'A', sub: 'pro' }),
    mkAccount({ name: 'B', sub: 'max_5x' }),
  ];
  const result = bestSwitchCandidate(accounts, null, mkCfg(), T0);
  assert.equal(result.name, 'B');
});

// === shouldPrePing() ===

test('shouldPrePing: elapsed=75min 触发第 1 备用 (4 帐号, stagger=75)', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.1,
    resetsAt: new Date(T0 + 225 * 60 * 1000).toISOString(),
    windowStart: T0 - 75 * 60 * 1000,
  });
  const accounts = [
    active,
    mkAccount({ name: 'A', sub: 'pro' }),
    mkAccount({ name: 'B', sub: 'pro' }),
    mkAccount({ name: 'C', sub: 'pro' }),
  ];
  const result = shouldPrePing(accounts, active, mkCfg(), T0);
  assert.ok(result, '应该返回一个未激活帐号');
  // A/B/C 同 sub 同 health，sort 稳定性可能不固定 — 只要返回任一即可
  assert.ok(['A', 'B', 'C'].includes(result.name));
});

test('shouldPrePing: usage=25% 触发第 1 备用 (即使时间未到)', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.25,
    resetsAt: new Date(T0 + 290 * 60 * 1000).toISOString(),
    windowStart: T0 - 10 * 60 * 1000,
  });
  const accounts = [
    active,
    mkAccount({ name: 'A', sub: 'pro' }),
    mkAccount({ name: 'B', sub: 'pro' }),
    mkAccount({ name: 'C', sub: 'pro' }),
  ];
  const result = shouldPrePing(accounts, active, mkCfg(), T0);
  assert.ok(result, '应该返回一个未激活帐号 (usage 触发)');
});

test('shouldPrePing: 没到时间也没到进度 → null', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.1,
    resetsAt: new Date(T0 + 270 * 60 * 1000).toISOString(),
    windowStart: T0 - 30 * 60 * 1000,
  });
  const accounts = [
    active,
    mkAccount({ name: 'A', sub: 'pro' }),
    mkAccount({ name: 'B', sub: 'pro' }),
    mkAccount({ name: 'C', sub: 'pro' }),
  ];
  const result = shouldPrePing(accounts, active, mkCfg(), T0);
  assert.equal(result, null);
});

test('shouldPrePing: 已有 1 备用在跑 → next_index=1, 触发第 2 备用 (elapsed=150min)', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.4,
    resetsAt: new Date(T0 + 150 * 60 * 1000).toISOString(),
    windowStart: T0 - 150 * 60 * 1000,
  });
  const accounts = [
    active,
    mkAccount({
      name: 'A',
      sub: 'pro',
      usage: 0.05,
      resetsAt: new Date(T0 + 225 * 60 * 1000).toISOString(),
      windowStart: T0 - 75 * 60 * 1000,
    }),
    mkAccount({ name: 'B', sub: 'pro' }),
    mkAccount({ name: 'C', sub: 'pro' }),
  ];
  const result = shouldPrePing(accounts, active, mkCfg(), T0);
  assert.ok(result);
  assert.ok(['B', 'C'].includes(result.name));
});

test('shouldPrePing: 所有备用都启动了 → null', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.1,
    resetsAt: new Date(T0 + 250 * 60 * 1000).toISOString(),
    windowStart: T0 - 50 * 60 * 1000,
  });
  const accounts = [
    active,
    mkAccount({
      name: 'A',
      sub: 'pro',
      usage: 0.1,
      resetsAt: new Date(T0 + 250 * 60 * 1000).toISOString(),
    }),
  ];
  const result = shouldPrePing(accounts, active, mkCfg(), T0);
  assert.equal(result, null);
});

test('shouldPrePing: N=1 → null (单帐号无错峰)', () => {
  const active = mkAccount({ name: 'M', sub: 'pro' });
  const result = shouldPrePing([active], active, mkCfg(), T0);
  assert.equal(result, null);
});

// === schedule() ===

test('schedule: 冷启动 (active=null) → 选健康度最高 + 返回 PING+USE', () => {
  const accounts = [
    mkAccount({ name: 'A', sub: 'pro' }),
    mkAccount({ name: 'B', sub: 'max_5x' }),
    mkAccount({ name: 'C', sub: 'pro' }),
  ];
  const actions = schedule(accounts, null, mkCfg(), T0);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, ACTION_PING);
  assert.equal(actions[0].account.name, 'B');
  assert.equal(actions[1].type, ACTION_USE);
  assert.equal(actions[1].account.name, 'B');
});

test('schedule: 主帐号耗尽 + 备用未激活 → PING + USE 备用', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'pro',
    usage: 1.0,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  const accounts = [
    active,
    mkAccount({ name: 'A', sub: 'max_5x' }),
    mkAccount({ name: 'B', sub: 'pro' }),
  ];
  const actions = schedule(accounts, active, mkCfg(), T0);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, ACTION_PING);
  assert.equal(actions[0].account.name, 'A');
  assert.equal(actions[1].type, ACTION_USE);
});

test('schedule: 主帐号耗尽 + 备用已激活 → 只 USE', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'pro',
    usage: 1.0,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  const accounts = [
    active,
    mkAccount({
      name: 'A',
      sub: 'max_5x',
      usage: 0.05,
      resetsAt: new Date(T0 + 240 * 60 * 1000).toISOString(),
    }),
  ];
  const actions = schedule(accounts, active, mkCfg(), T0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, ACTION_USE);
  assert.equal(actions[0].account.name, 'A');
});

test('schedule: 主帐号健康 + 该预 ping → 仅 PING', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.3,
    resetsAt: new Date(T0 + 220 * 60 * 1000).toISOString(),
    windowStart: T0 - 80 * 60 * 1000,
  });
  const accounts = [
    active,
    mkAccount({ name: 'A', sub: 'pro' }),
    mkAccount({ name: 'B', sub: 'pro' }),
    mkAccount({ name: 'C', sub: 'pro' }),
  ];
  const actions = schedule(accounts, active, mkCfg(), T0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, ACTION_PING);
});

test('schedule: 没动作 → 空数组', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'max_5x',
    usage: 0.1,
    resetsAt: new Date(T0 + 290 * 60 * 1000).toISOString(),
    windowStart: T0 - 10 * 60 * 1000,
  });
  const accounts = [active];
  const actions = schedule(accounts, active, mkCfg(), T0);
  assert.deepEqual(actions, []);
});

test('schedule: 全部耗尽 → 空数组', () => {
  const active = mkAccount({
    name: 'M',
    sub: 'pro',
    usage: 1.0,
    resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
  });
  const accounts = [
    active,
    mkAccount({
      name: 'A',
      sub: 'pro',
      usage: 1.0,
      resetsAt: new Date(T0 + 60 * 60 * 1000).toISOString(),
    }),
  ];
  const actions = schedule(accounts, active, mkCfg(), T0);
  assert.deepEqual(actions, []);
});
