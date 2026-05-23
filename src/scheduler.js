// 调度逻辑 - 纯函数，不读写文件
//
// 决定「现在该不该 ping 某个帐号」与「下一个该切换到哪个帐号」。
//
// 错峰算法：
//   - 假设 N 个帐号，interval_minutes = M
//   - 启动时刻 T0，每个帐号有 offset_minutes (primary=0, secondary=M, tertiary=2M...)
//   - 帐号 i 首次 ping 时间 = T0 + offset_i
//   - 同一帐号续 ping 周期 = M * N（每 N*M 分钟重 ping 一次以续 5h 窗口）
//   - 假设 N=3, M=100:
//       T0      → ping primary
//       T0+100  → ping secondary
//       T0+200  → ping tertiary
//       T0+300  → 又轮到 primary
//
// 设计原则：
//   - 所有函数接收 `now` 参数（默认 new Date()），便于测试用固定时间
//   - 不读写任何文件，state/config 由调用方传入

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * 计算某帐号下次应该 ping 的时间。
 *
 * @param {Object} account     - {name, offset_minutes, ...}
 * @param {Object} state       - 含 started_at, last_pings
 * @param {Object} config      - 含 interval_minutes
 * @param {Array}  allAccounts - 全部帐号（用于计算循环周期）
 * @returns {Date}             - 下次 ping 时间
 *
 * 规则:
 *   - 从未 ping  : startedAt + offset_minutes
 *   - 已 ping 过 : last_pings[name] + interval_minutes * allAccounts.length
 *
 * state.started_at 为 null 时退化为「立即可 ping」(返回 epoch 0)，
 * 防止在守护进程尚未记录启动时间时无限阻塞。
 */
export function nextPingTime(account, state, config, allAccounts) {
  const intervalMin = config.interval_minutes;
  const cycleMin = intervalMin * allAccounts.length;
  const last = state.last_pings?.[account.name];

  if (last) {
    return new Date(new Date(last).getTime() + cycleMin * MS_PER_MINUTE);
  }

  // 首次 ping
  if (!state.started_at) {
    // 无启动时间记录 → 立即可 ping
    return new Date(0);
  }
  const startedAtMs = new Date(state.started_at).getTime();
  return new Date(startedAtMs + (account.offset_minutes ?? 0) * MS_PER_MINUTE);
}

/**
 * 判断给定时刻是否应当 ping 该帐号。
 *
 * @returns {boolean} - now >= nextPingTime
 */
export function shouldPingNow(account, state, config, allAccounts, now = new Date()) {
  const next = nextPingTime(account, state, config, allAccounts);
  return now.getTime() >= next.getTime();
}

/**
 * 找出当前时刻所有「应该被 ping」的帐号，按 offset_minutes 升序返回。
 *
 * @returns {Array} - 该 ping 的 accounts 列表
 */
export function dueAccounts(state, config, now = new Date()) {
  const accounts = config.accounts ?? [];
  return accounts
    .filter((a) => shouldPingNow(a, state, config, accounts, now))
    .sort((a, b) => (a.offset_minutes ?? 0) - (b.offset_minutes ?? 0));
}

/**
 * 估算某帐号 5h 窗口的剩余分钟数。
 *
 * @returns {number|null} - 未 ping 过返回 null；已 ping 过返回 >=0 的整数分钟
 */
export function estimatedRemainingMinutes(account, state, now = new Date()) {
  const last = state.last_pings?.[account.name];
  if (!last) return null;
  const elapsedMs = now.getTime() - new Date(last).getTime();
  const remainingMs = FIVE_HOURS_MS - elapsedMs;
  return Math.max(0, Math.round(remainingMs / MS_PER_MINUTE));
}

/**
 * 推荐「现在该切换到」的帐号 —— 剩余 5h 窗口最长的那个。
 *
 * 选择策略:
 *   1. 优先选已 ping 过的帐号中剩余时间最多的
 *   2. 全部都没 ping 过 → 返回 primary (offset_minutes 最小的)
 *   3. 帐号列表为空 → 返回 null
 *
 * 这样能保证：用户随时调用 `recommendedAccount` 都能拿到「窗口最新鲜」的那个，
 * 既最大化 5h 窗口使用率，又避免被快过期的帐号坑到。
 *
 * @returns {Object|null}
 */
export function recommendedAccount(state, config, now = new Date()) {
  const accounts = config.accounts ?? [];
  if (accounts.length === 0) return null;

  // 已 ping 过的帐号 + 剩余分钟
  const pinged = accounts
    .map((a) => ({ account: a, remaining: estimatedRemainingMinutes(a, state, now) }))
    .filter((x) => x.remaining !== null);

  if (pinged.length > 0) {
    // 取剩余最大者；并列时取 offset 较小者（更稳定）
    pinged.sort((a, b) => {
      if (b.remaining !== a.remaining) return b.remaining - a.remaining;
      return (a.account.offset_minutes ?? 0) - (b.account.offset_minutes ?? 0);
    });
    return pinged[0].account;
  }

  // 全部没 ping 过 → primary（offset 最小）
  const sorted = [...accounts].sort(
    (a, b) => (a.offset_minutes ?? 0) - (b.offset_minutes ?? 0)
  );
  return sorted[0];
}
