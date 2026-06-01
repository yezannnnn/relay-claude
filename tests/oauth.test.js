import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpiringSoon, CLIENT_ID, queryUsage } from '../src/oauth.js';

// Mock requestFn for normalizeUtilization tests (API returns percentage floats)
function mockUsage(utilization) {
  return async () => ({
    status: 200, ok: true,
    body: JSON.stringify({
      five_hour: { utilization, resets_at: '2026-06-01T20:00:00Z' },
      seven_day: { utilization, resets_at: '2026-06-07T20:00:00Z' },
    }),
  });
}

test('CLIENT_ID is the known claude CLI uuid', () => {
  assert.equal(CLIENT_ID, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
});

test('isExpiringSoon returns true for past expiresAt', () => {
  const credentials = { expiresAt: Date.now() - 1000 };
  assert.equal(isExpiringSoon(credentials), true);
});

test('isExpiringSoon returns true within threshold', () => {
  const credentials = { expiresAt: Date.now() + 5 * 60 * 1000 };
  assert.equal(isExpiringSoon(credentials), true);
});

test('isExpiringSoon returns false beyond threshold', () => {
  const credentials = { expiresAt: Date.now() + 30 * 60 * 1000 };
  assert.equal(isExpiringSoon(credentials), false);
});

test('isExpiringSoon returns true for missing expiresAt', () => {
  assert.equal(isExpiringSoon({}), true);
  assert.equal(isExpiringSoon({ expiresAt: null }), true);
});

// normalizeUtilization: API returns percentage floats (17.0 = 17%, 1.0 = 1%)
// The boundary v=1.0 must be treated as 1%, NOT as decimal 100%
test('normalizeUtilization: 1.0 from API is 1%, stored as 0.01', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(1.0) });
  // Raw API 1.0 = 1%, must not be treated as 100%
  assert.equal(usage.five_hour.utilization, 0.01);
  assert.equal(usage.seven_day.utilization, 0.01);
});

test('normalizeUtilization: 17.0 from API is 17%, stored as 0.17', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(17.0) });
  assert.equal(usage.five_hour.utilization, 0.17);
});

test('normalizeUtilization: 100.0 from API is 100%, stored as 1.0', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(100.0) });
  assert.equal(usage.five_hour.utilization, 1.0);
});

test('normalizeUtilization: 0.0 stays 0', async () => {
  const usage = await queryUsage('tok', { requestFn: mockUsage(0.0) });
  assert.equal(usage.five_hour.utilization, 0);
});
