// 调用 claude -p 触发帐号的 5h 重置窗口
//
// 关键设计:
//   - 通过 spawn 启动 claude，向子进程注入 CLAUDE_CODE_OAUTH_TOKEN 环境变量
//     这样多个帐号可以串行使用各自的 token，互不污染（不修改 process.env）
//   - 失败重试用指数退避，避免短时间内打爆 claude CLI
//   - 批量 ping 走顺序模式，因为 claude CLI 内部可能有共享状态/认证缓存

import { spawn as defaultSpawn } from 'node:child_process';
import os from 'node:os';
import { getAccessToken } from './config.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLAUDE_BIN = 'claude';
const DEFAULT_PROMPT = 'hi';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;

/**
 * 等待指定毫秒数（用于重试退避，测试可注入 sleepFn 跳过等待）。
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检测 claude 输出是否表示 "limit reached"（额度已耗尽）。
 * Claude CLI 返回额度问题时的 stdout/stderr 包含 "hit your limit" / "resets at" 等关键字。
 */
function detectLimitReached(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  return (
    text.includes("you've hit your limit") ||
    text.includes('rate limit') ||
    text.includes('quota exceeded') ||
    text.includes('limit · resets') ||
    text.includes('limit. resets')
  );
}

/**
 * Ping 一个帐号 — 设置 CLAUDE_CODE_OAUTH_TOKEN 环境变量后调 claude -p
 *
 * @param {{name: string, token: string, offset_minutes?: number}} account
 * @param {string} [prompt='hi'] - 发送给 claude 的内容
 * @param {{
 *   timeoutMs?: number,
 *   claudeBin?: string,
 *   spawnFn?: Function,
 * }} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   code: number|null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   durationMs: number,
 * }>}
 */
export async function pingAccount(account, prompt, options = {}) {
  if (!account || typeof account !== 'object') {
    throw new Error('pingAccount: account 必须为对象');
  }

  const token = getAccessToken(account);
  if (!token) {
    throw new Error(
      `account "${account.name}" has no token available (missing credentials.accessToken or legacy_token)`,
    );
  }

  const effectivePrompt =
    typeof prompt === 'string' && prompt.length > 0 ? prompt : DEFAULT_PROMPT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claudeBin = options.claudeBin ?? DEFAULT_CLAUDE_BIN;
  const spawnFn = options.spawnFn ?? defaultSpawn;
  const model = options.model ?? 'haiku';  // 默认用 haiku 最省额度

  // 关键：用对象展开构造新 env，不修改全局 process.env
  const childEnv = {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: token,
  };

  const args = ['-p', effectivePrompt, '--model', model];
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(claudeBin, args, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        cwd: os.homedir(),
      });
    } catch (err) {
      resolve({
        success: false,
        code: null,
        stdout: '',
        stderr: String(err?.message ?? err),
        timedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let settled = false;

    function toBuffer(chunk) {
      return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    }

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => stdoutChunks.push(toBuffer(chunk)));
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => stderrChunks.push(toBuffer(chunk)));
    }

    // 手动 timeout 兜底：某些场景 spawn 的 timeout 不可靠（mock 场景、子进程
    // 已 fork 出新进程等）。到点主动 kill 并标记 timedOut。
    const manualTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        if (typeof child.kill === 'function') {
          child.kill('SIGTERM');
        }
      } catch {
        // 忽略 kill 失败 — exit/close 事件仍可能到来
      }
    }, timeoutMs + 50);

    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(manualTimer);
      resolve(result);
    }

    function finalize(code, signal) {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const limitReached = detectLimitReached(stdout, stderr);
      const success = !timedOut && code === 0 && !limitReached;
      settle({
        success,
        code: typeof code === 'number' ? code : null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        signal: signal ?? null,
        limitReached,
      });
    }

    child.on('error', (err) => {
      // spawn 自身报错（claude 不存在）或 timeout（killed=true 时 Node 会派发 error）
      // 都走失败路径
      if (err && err.code === 'ETIMEDOUT') {
        timedOut = true;
      }
      const stderr =
        Buffer.concat(stderrChunks).toString('utf8') ||
        String(err?.message ?? err);
      settle({
        success: false,
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        signal: null,
      });
    });

    child.on('exit', (code, signal) => {
      if (signal === 'SIGTERM' && child.killed) {
        // 被我们主动 kill 掉，多半是超时
        timedOut = timedOut || true;
      }
      finalize(code, signal);
    });
  });
}

/**
 * Ping + 失败重试（指数退避）
 *
 * 退避序列: baseDelayMs * 2^(N-1) — 默认 1s, 2s, 4s
 *
 * @param {object} account
 * @param {string} [prompt]
 * @param {{
 *   maxRetries?: number,
 *   baseDelayMs?: number,
 *   sleepFn?: Function,
 *   timeoutMs?: number,
 *   claudeBin?: string,
 *   spawnFn?: Function,
 * }} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   attempts: number,
 *   lastResult: object,
 *   results: Array,
 * }>}
 */
export async function pingWithRetry(account, prompt, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleepFn ?? defaultSleep;

  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error('pingWithRetry: maxRetries 必须为 >=1 的整数');
  }

  const pingOptions = {
    timeoutMs: options.timeoutMs,
    claudeBin: options.claudeBin,
    spawnFn: options.spawnFn,
    model: options.model,
  };

  const results = [];
  let lastResult = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    lastResult = await pingAccount(account, prompt, pingOptions);
    results.push(lastResult);

    if (lastResult.success) {
      return {
        success: true,
        attempts: attempt,
        lastResult,
        results,
      };
    }

    // 还有重试次数 → 退避后再试
    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  return {
    success: false,
    attempts: maxRetries,
    lastResult,
    results,
  };
}

/**
 * 批量 ping（顺序执行，避免 claude CLI 状态污染）
 *
 * 每个帐号独立执行；单帐号失败不会中断后续 ping。
 *
 * @param {Array} accounts
 * @param {string} [prompt]
 * @param {object} [options] - 透传给 pingAccount / pingWithRetry
 *   - withRetry: 是否对每个帐号走重试逻辑（默认 false）
 * @returns {Promise<Array<{account: string, result: object}>>}
 */
export async function pingAll(accounts, prompt, options = {}) {
  if (!Array.isArray(accounts)) {
    throw new Error('pingAll: accounts 必须为数组');
  }

  const useRetry = options.withRetry === true;
  const results = [];

  for (const account of accounts) {
    const result = useRetry
      ? await pingWithRetry(account, prompt, options)
      : await pingAccount(account, prompt, options);
    results.push({ account: account.name, result });
  }

  return results;
}
