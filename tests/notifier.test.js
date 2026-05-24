import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOsascriptArgs, escapeForApplescript, sendNotification } from '../src/notifier.js';

test('escapeForApplescript: 转义双引号', () => {
  assert.equal(escapeForApplescript('hello "world"'), 'hello \\"world\\"');
});

test('escapeForApplescript: 转义反斜杠', () => {
  assert.equal(escapeForApplescript('foo\\bar'), 'foo\\\\bar');
});

test('escapeForApplescript: null/undefined → 空字符串', () => {
  assert.equal(escapeForApplescript(null), '');
  assert.equal(escapeForApplescript(undefined), '');
});

test('buildOsascriptArgs: 基本通知', () => {
  const args = buildOsascriptArgs({ title: 'A', message: 'M' });
  assert.equal(args[0], '-e');
  assert.ok(args[1].includes('"M"'));
  assert.ok(args[1].includes('with title "A"'));
});

test('buildOsascriptArgs: 含 subtitle', () => {
  const args = buildOsascriptArgs({ title: 'A', subtitle: 'S', message: 'M' });
  assert.ok(args[1].includes('subtitle "S"'));
});

test('buildOsascriptArgs: 含 sound', () => {
  const args = buildOsascriptArgs({ title: 'A', message: 'M', sound: 'Submarine' });
  assert.ok(args[1].includes('sound name "Submarine"'));
});

test('sendNotification: 空 message → 返回 false', async () => {
  const result = await sendNotification({ title: 'A' });
  assert.equal(result, false);
});

test('sendNotification: 非 darwin → 返回 false', async () => {
  if (process.platform === 'darwin') {
    // 当前平台是 darwin，跳过此分支测试
    return;
  }
  const result = await sendNotification({ message: 'test' });
  assert.equal(result, false);
});
