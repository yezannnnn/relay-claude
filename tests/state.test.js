// state.js 单元测试

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function freshModule() {
  return await import('../src/state.js');
}

let tmpHome;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'interval-claude-state-'));
  process.env.INTERVAL_CLAUDE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.INTERVAL_CLAUDE_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

test('loadState: 默认状态加载', async () => {
  const { loadState } = await freshModule();
  const s = await loadState();
  assert.equal(s.daemon_pid, null);
  assert.equal(s.started_at, null);
  assert.deepEqual(s.last_pings, {});
});

test('recordPing: 写入并能读出', async () => {
  const { recordPing, loadState } = await freshModule();
  const ts = '2026-05-23T09:00:15.000Z';
  await recordPing('primary', ts);
  const s = await loadState();
  assert.equal(s.last_pings.primary, ts);
});

test('recordPing: 多次写入累积不互相覆盖', async () => {
  const { recordPing, loadState } = await freshModule();
  await recordPing('primary', '2026-05-23T09:00:00.000Z');
  await recordPing('secondary', '2026-05-23T10:40:00.000Z');
  const s = await loadState();
  assert.equal(s.last_pings.primary, '2026-05-23T09:00:00.000Z');
  assert.equal(s.last_pings.secondary, '2026-05-23T10:40:00.000Z');
});

test('setDaemonPid + isDaemonAlive: 当前进程 pid 应返回 true', async () => {
  const { setDaemonPid, isDaemonAlive, loadState } = await freshModule();
  await setDaemonPid(process.pid);
  const s = await loadState();
  assert.equal(s.daemon_pid, process.pid);
  assert.ok(typeof s.started_at === 'string' && s.started_at.length > 0);

  const alive = await isDaemonAlive();
  assert.equal(alive, true);
});

test('isDaemonAlive: 不存在的 pid 返回 false', async () => {
  const { setDaemonPid, isDaemonAlive } = await freshModule();
  // 选择一个几乎不可能存在的 pid。多数系统 pid_max 远低于此值。
  await setDaemonPid(99999999);
  const alive = await isDaemonAlive();
  assert.equal(alive, false);
});

test('isDaemonAlive: daemon_pid 为 null 时返回 false', async () => {
  const { isDaemonAlive } = await freshModule();
  // 默认状态 daemon_pid = null
  const alive = await isDaemonAlive();
  assert.equal(alive, false);
});

test('clearDaemonPid: 清空 daemon_pid 和 started_at', async () => {
  const { setDaemonPid, clearDaemonPid, loadState } = await freshModule();
  await setDaemonPid(process.pid);
  await clearDaemonPid();
  const s = await loadState();
  assert.equal(s.daemon_pid, null);
  assert.equal(s.started_at, null);
});

test('saveState: 写入后 last_pings 保留', async () => {
  const { saveState, loadState } = await freshModule();
  await saveState({
    daemon_pid: 1234,
    started_at: '2026-05-23T09:00:00.000Z',
    last_pings: { primary: '2026-05-23T09:00:15.000Z', secondary: null },
  });
  const s = await loadState();
  assert.equal(s.daemon_pid, 1234);
  assert.equal(s.last_pings.primary, '2026-05-23T09:00:15.000Z');
  assert.equal(s.last_pings.secondary, null);
});

test('saveState: 文件权限 0o600 (Unix-only)', { skip: process.platform === 'win32' }, async () => {
  const { saveState, getStatePath } = await freshModule();
  await saveState({ daemon_pid: null, started_at: null, last_pings: {} });
  const stat = await fs.stat(getStatePath());
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
});
