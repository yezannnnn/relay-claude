// ASCII banner — 打印于 help / version / start 等入口
// 同时作为版本号单一来源（避免多处硬编码）

export const VERSION = '0.4.2';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

const ART = `
  ____     _                 ____ _                _
 |  _ \\ ___| | __ _ _   _   / ___| | __ _ _   _  __| | ___
 | |_) / _ \\ |/ _\` | | | | | |   | |/ _\` | | | |/ _\` |/ _ \\
 |  _ <  __/ | (_| | |_| | | |___| | (_| | |_| | (_| |  __/
 |_| \\_\\___|_|\\__,_|\\__, |  \\____|_|\\__,_|\\__,_|\\__,_|\\___|
                    |___/`;

/**
 * 打印 banner 到 stdout。
 * @param {object} [opts]
 * @param {string} [opts.version] - 在 banner 下方显示版本号
 * @param {string} [opts.tagline] - 自定义副标题
 */
export function printBanner({ version, tagline } = {}) {
  const lines = ART.split('\n');
  for (const line of lines) {
    console.log(`${C.cyan}${line}${C.reset}`);
  }
  console.log();
  const subtitle = tagline ?? '多账户 Claude Code 额度接力 · 错峰激活 5h 窗口';
  const ver = version ? `${C.dim}v${version}${C.reset}` : '';
  console.log(`  ${C.bold}◆${C.reset}  ${subtitle}  ${ver}`);
  console.log(
    `  ${C.dim}│${C.reset}  ${C.gray}https://github.com/yezannnnn/relay-claude${C.reset}`,
  );
  console.log();
}

/**
 * 紧凑版 banner（单行 logo + 副标题）— 适合 watch/tui 等场景的标题栏
 */
export function getCompactBanner() {
  return `${C.cyan}${C.bold}▲ relay-claude${C.reset}`;
}
