// 共享的 stdin 行输入工具
//
// 为什么不直接用 readline/promises:
//   node 22 之前的 readline/promises 在 stdin 是非交互管道时，
//   第二次 question() 在 EOF 后永远 pending（已知 bug）。
//   我们的 init/add 命令需要顺序读两行（name + token），所以自己实现。
//
// 实现:
//   - 用 readline 一次性把所有 line 收集到队列
//   - prompt() 写出提示符后从队列取下一行
//   - EOF 时未取的 prompt() 立即返回空串
//
// 仅在本进程被实例化一次（lazy 单例）。

import { createInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

let lineQueue = null;
let waiters = null;
let finished = false;
let rl = null;

function ensureReader() {
  if (lineQueue) return;
  lineQueue = [];
  waiters = [];
  rl = createInterface({ input, output: undefined, terminal: false });
  rl.on('line', (line) => {
    if (waiters.length > 0) {
      const w = waiters.shift();
      w(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on('close', () => {
    finished = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w('');
    }
  });
}

/**
 * 写出提示符到 stdout，然后从 stdin 读取一行（不含换行符）。
 * 已 EOF 时立刻返回空字符串。
 */
export function prompt(text) {
  ensureReader();
  output.write(text);
  if (lineQueue.length > 0) {
    return Promise.resolve(lineQueue.shift());
  }
  if (finished) {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** 关闭底层 readline，让进程能正常退出 */
export function closePrompt() {
  if (rl) {
    rl.close();
    rl = null;
  }
}
