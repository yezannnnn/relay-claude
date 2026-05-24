// src/scheduler.js
// v0.3 动态调度算法 (取代 v0.2 的 i × 300/N 固定时间表)
//
// 输入：accounts 数组、当前活跃帐号、配置、当前时间
// 输出：动作数组，每个动作是 { type: 'PING'|'USE', account }
//
// 核心思想：每周期评估"目标状态"vs"实际状态"，差异触发动作。
//   - 主帐号无效（耗尽/过期/limit）→ 切到健康度最高的备用
//   - 主帐号有效但未达"备用窗口数 ≥ next_index" → 预 ping 启动备用
//   - 否则不动

export const DEFAULT_SUB_WEIGHTS = {
  pro: 1,
  max_5x: 5,
  max_20x: 20,
  team: 10,
  _default: 1,
};

export const DEFAULT_EXPIRE_THRESHOLD_MIN = 3;
export const FULL_WINDOW_MIN = 300; // 5h
export const LIMIT_REACHED_VALID_MS = 10 * 60 * 1000; // 10 min

export const ACTION_PING = 'PING';
export const ACTION_USE = 'USE';

function subWeight(account, cfg) {
  const weights = cfg?.scheduler?.sub_weights ?? DEFAULT_SUB_WEIGHTS;
  const sub = account?.credentials?.subscriptionType ?? '_default';
  return weights[sub] ?? weights._default ?? 1;
}

function isWindowNotStarted(account) {
  return !account?.last_usage?.five_hour?.resets_at;
}

function isWindowExpired(account, now) {
  const ts = account?.last_usage?.five_hour?.resets_at;
  if (!ts) return false;
  return new Date(ts).getTime() <= now;
}

function windowRemainingMin(account, now) {
  const ts = account?.last_usage?.five_hour?.resets_at;
  if (!ts) return 0;
  const ms = new Date(ts).getTime() - now;
  return Math.max(0, ms / 60000);
}

function currentUsage(account) {
  return account?.last_usage?.five_hour?.utilization ?? 0;
}

/**
 * 计算健康度评分。
 * - 未激活/已过期：weight × 1.0 × 300 (满血潜在)
 * - 耗尽：0
 * - 即将过期 (< threshold)：0
 * - 活跃中：weight × (1-usage) × remaining_min
 */
export function health(account, cfg, now = Date.now()) {
  if (!account) return 0;
  const weight = subWeight(account, cfg);

  if (isWindowNotStarted(account)) {
    return weight * 1.0 * FULL_WINDOW_MIN;
  }
  if (currentUsage(account) >= 1.0) return 0;
  if (isWindowExpired(account, now)) {
    return weight * 1.0 * FULL_WINDOW_MIN;
  }
  const remaining = windowRemainingMin(account, now);
  const threshold = cfg?.scheduler?.expire_threshold_min ?? DEFAULT_EXPIRE_THRESHOLD_MIN;
  if (remaining < threshold) return 0;
  const remainingUsage = 1 - currentUsage(account);
  return weight * remainingUsage * remaining;
}

/** 判断是否需要切换主帐号 */
export function needsSwitch(active, cfg, now = Date.now()) {
  if (!active) return true;
  if (currentUsage(active) >= 1.0) return true;
  if (isWindowExpired(active, now)) return true;
  if (
    active.limit_reached_at &&
    now - active.limit_reached_at < LIMIT_REACHED_VALID_MS
  ) {
    return true;
  }
  return false;
}

/** 选最佳切换候选 */
export function bestSwitchCandidate(accounts, exclude, cfg, now = Date.now()) {
  const candidates = accounts.filter((a) => {
    if (exclude && a.name === exclude.name) return false;
    return health(a, cfg, now) > 0;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => health(b, cfg, now) - health(a, cfg, now));
  return candidates[0];
}

/**
 * 错峰预 ping 判断。
 * 双信号触发（时间 / 进度），任一满足即触发。
 */
export function shouldPrePing(accounts, active, cfg, now = Date.now()) {
  if (!active) return null;
  const N = accounts.length;
  if (N <= 1) return null;

  const dormant = accounts
    .filter((a) => a.name !== active.name && isWindowNotStarted(a))
    .sort((a, b) => health(b, cfg, now) - health(a, cfg, now));
  if (dormant.length === 0) return null;

  const runningBackups = accounts.filter(
    (a) =>
      a.name !== active.name &&
      !isWindowNotStarted(a) &&
      !isWindowExpired(a, now) &&
      currentUsage(a) < 1.0
  ).length;

  const nextIndex = runningBackups;
  if (nextIndex >= dormant.length) return null;

  const stagger = cfg?.scheduler?.stagger_min ?? FULL_WINDOW_MIN / N;
  const targetTimeMin = (nextIndex + 1) * stagger;
  const prePingThreshold = cfg?.scheduler?.preping_usage_threshold ?? 0.5;

  // 计算主帐号已运行多久 — 优先用显式 window_start，回退反推自 resets_at
  let windowStartMs;
  if (active.window_start) {
    windowStartMs = active.window_start;
  } else if (active.last_usage?.five_hour?.resets_at) {
    windowStartMs =
      new Date(active.last_usage.five_hour.resets_at).getTime() -
      FULL_WINDOW_MIN * 60_000;
  } else {
    windowStartMs = now;
  }
  const elapsedMin = (now - windowStartMs) / 60_000;
  const usage = currentUsage(active);

  if (elapsedMin >= targetTimeMin || usage >= prePingThreshold) {
    return dormant[0];
  }
  return null;
}

/**
 * 完整调度循环 — 返回动作数组（每周期最多两条）
 */
export function schedule(accounts, active, cfg, now = Date.now()) {
  if (needsSwitch(active, cfg, now)) {
    const candidate = bestSwitchCandidate(accounts, active, cfg, now);
    if (!candidate) return [];
    if (isWindowNotStarted(candidate)) {
      return [
        { type: ACTION_PING, account: candidate },
        { type: ACTION_USE, account: candidate },
      ];
    }
    return [{ type: ACTION_USE, account: candidate }];
  }

  const next = shouldPrePing(accounts, active, cfg, now);
  if (next) {
    return [{ type: ACTION_PING, account: next }];
  }

  return [];
}

// === v0.2 向后兼容 API（保留以免破坏其它模块）===

/**
 * 返回最适合切换到的帐号。
 * 沿用 v0.2 接口签名 (state, config, now)。
 */
export function recommendedAccount(state, config, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const accounts = config.accounts ?? [];
  if (accounts.length === 0) return null;
  const cfg = config.scheduler ? config : { ...config, scheduler: {} };
  const valid = accounts.filter((a) => health(a, cfg, nowMs) > 0);
  if (valid.length === 0) return accounts[0];
  valid.sort((a, b) => health(b, cfg, nowMs) - health(a, cfg, nowMs));
  return valid[0];
}

/** v0.2 兼容占位 — daemon Task 2 已不再调用 */
export function dueAccounts() {
  return [];
}

/** v0.2 兼容 — switch/list 仍可能调用 */
export function estimatedRemainingMinutes(account, state, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return Math.round(windowRemainingMin(account, nowMs));
}

/** v0.2 兼容 */
export function nextPingTime() {
  return null;
}

/** v0.2 兼容 */
export function shouldPingNow() {
  return false;
}
