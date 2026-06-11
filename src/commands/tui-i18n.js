// src/commands/tui-i18n.js
// TUI 展示文案的中英双语字典。
// 参数化文案用函数表达；纯短状态码（wait/soon/ping@Nm）两语种一致，不收录。
//
// 宽度提示：状态标签受列宽 14 限制，emoji 视觉宽 2、CJK 宽 2、ASCII 宽 1，
// 英文用短词（limit/dormant…）保证倒计时三位数也不溢出。

export const STRINGS = {
  zh: {
    running: '运行中',
    stopped: '未运行',
    pollHint: (n) => `usage 每 ${n}min 轮询一次`,
    pollHintOff: 'daemon 未运行，数据不刷新',
    accountsSuffix: '个账户',

    schedTitle: '调度策略',
    panelActive: '活跃',
    none: '(无)',
    nextActionLabel: '下一动作',
    thresholdLine: (pp, st, n) =>
      `阈值: 切换=100%   预ping=${pp}% 或 ${st}min   错峰间隔=${st}min (300 ÷ ${n})`,

    colHp: 'H分',
    colState: '状态',
    noAccounts: '(无帐号，运行 relay-claude add <name> 添加)',

    reloaded: '已从缓存重新加载（daemon 后台轮询负责数据更新）',
    switching: (n) => `正在切换到 ${n}...`,
    switched: (n) => `已切换到 ${n}`,
    switchFail: (e) => `切换失败: ${e}`,
    pinging: (n) => `正在 ping ${n}...`,
    pingErr: (n, e) => `❌ ping ${n}: ${e}`,
    pingOk: (n, ms) => `✅ ping ${n} OK (${ms}ms)`,
    pingFail: (n, ms, r) => `❌ ping ${n} 失败 (${ms}ms): ${r}`,
    pingExc: (e) => `❌ ping 异常: ${e}`,

    stRateLimited: '限流',
    stError: '异常',
    stActiveError: '活跃·异常',
    stActive: '活跃',
    stExhausted: '耗尽',
    stBackup: '备用',
    stBackupStale: '备用·旧',
    stDormant: '待激活',
    barRateLimited: '⚠限',
    barStale: '?旧',

    // 第一项为按键，第二项为说明；'l' 显示「将切换到的目标语言」
    help: [['↑↓', '选择'], ['Enter', '切换'], ['p', 'ping'], ['r', '刷新'], ['l', 'English'], ['q', '退出']],

    saNoAccount: '无可用账户',
    saSwitch: '切换',
    saReasonNoActive: '（无活跃账户，立即）',
    saAllExhausted: '所有账户耗尽',
    saReasonWaitReset: '（等最早重置）',
    saReasonActiveInvalid: '（活跃失效，立即）',
    saPrePing: '预 PING',
    saReasonCondMet: '（条件已满足，下个调度周期）',
    saChainRelay: '等链式接力',
    saReasonChain: (n) => `（${n} 已激活，活跃耗尽后切给它）`,
    saNoBackup: '无可预 PING 的备用账户',
    saReasonImminent: '（即将）',
    saReasonByTime: (m) => `（${m}min 后，时间到 stagger）`,
    saReasonByUsage: (m, pct) => `（${m}min 后，用量达 ${pct}%）`,
  },

  en: {
    running: 'running',
    stopped: 'stopped',
    pollHint: (n) => `usage polled every ${n}min`,
    pollHintOff: 'daemon not running, data is stale',
    accountsSuffix: 'accounts',

    schedTitle: 'Scheduling',
    panelActive: 'Active',
    none: '(none)',
    nextActionLabel: 'Next',
    thresholdLine: (pp, st, n) =>
      `Thresholds: switch=100%   pre-ping=${pp}% or ${st}min   stagger=${st}min (300 ÷ ${n})`,

    colHp: 'HP',
    colState: 'STATUS',
    noAccounts: '(no accounts, run relay-claude add <name>)',

    reloaded: 'Reloaded from cache (daemon refreshes data in background)',
    switching: (n) => `Switching to ${n}...`,
    switched: (n) => `Switched to ${n}`,
    switchFail: (e) => `Switch failed: ${e}`,
    pinging: (n) => `Pinging ${n}...`,
    pingErr: (n, e) => `❌ ping ${n}: ${e}`,
    pingOk: (n, ms) => `✅ ping ${n} OK (${ms}ms)`,
    pingFail: (n, ms, r) => `❌ ping ${n} failed (${ms}ms): ${r}`,
    pingExc: (e) => `❌ ping error: ${e}`,

    stRateLimited: 'limit',
    stError: 'error',
    stActiveError: 'active·err',
    stActive: 'active',
    stExhausted: 'exhausted',
    stBackup: 'backup',
    stBackupStale: 'backup·old',
    stDormant: 'dormant',
    barRateLimited: '⚠RL',
    barStale: 'old',

    help: [['↑↓', 'select'], ['Enter', 'switch'], ['p', 'ping'], ['r', 'reload'], ['l', '中文'], ['q', 'quit']],

    saNoAccount: 'no account available',
    saSwitch: 'Switch',
    saReasonNoActive: ' (no active account, now)',
    saAllExhausted: 'all accounts exhausted',
    saReasonWaitReset: ' (waiting earliest reset)',
    saReasonActiveInvalid: ' (active invalid, now)',
    saPrePing: 'pre-PING',
    saReasonCondMet: ' (condition met, next cycle)',
    saChainRelay: 'chain relay',
    saReasonChain: (n) => ` (${n} ready, switches when active exhausts)`,
    saNoBackup: 'no backup to pre-PING',
    saReasonImminent: ' (imminent)',
    saReasonByTime: (m) => ` (in ${m}min, stagger reached)`,
    saReasonByUsage: (m, pct) => ` (in ${m}min, usage hits ${pct}%)`,
  },
};

/** 取某语言的文案表，非法语言回退 zh。 */
export function strings(lang) {
  return STRINGS[lang === 'en' ? 'en' : 'zh'];
}
