import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyScoreFloor, buildCategories, buildVetResult } = await import('../src/categories.ts');

// ── applyScoreFloor ──────────────────────────────────────────────────────────

test('applyScoreFloor: non-security check with score 0 gets floor of 20', () => {
  const check = { name: 'models', score: 0, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 20);
});

test('applyScoreFloor: non-security check with score 15 gets floor of 20', () => {
  const check = { name: 'verify', score: 15, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 20);
});

test('applyScoreFloor: non-security check with score 50 stays at 50', () => {
  const check = { name: 'debt', score: 50, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 50);
});

test('applyScoreFloor: security check (scan) with score 0 stays at 0', () => {
  const check = { name: 'scan', score: 0, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 0);
});

test('applyScoreFloor: security check (secrets) with score 0 stays at 0', () => {
  const check = { name: 'secrets', score: 0, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 0);
});

test('applyScoreFloor: security check (permissions) with score 0 stays at 0', () => {
  const check = { name: 'permissions', score: 0, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 0);
});

test('applyScoreFloor: security check (owasp) with score 0 stays at 0', () => {
  const check = { name: 'owasp', score: 0, maxScore: 100, issues: [], summary: 'test' };
  assert.equal(applyScoreFloor(check), 0);
});

// ── Floor applied in category scoring ────────────────────────────────────────

test('buildCategories: non-security check floor prevents cratering category', () => {
  const checkMap = {
    security: [{ name: 'scan', score: 100, maxScore: 100, issues: [], summary: 'clean' }],
    integrity: [
      { name: 'verify', score: 0, maxScore: 100, issues: [{ severity: 'error', message: 'test', fixable: false }], summary: 'bad' },
      { name: 'models', score: 100, maxScore: 100, issues: [], summary: 'clean' },
    ],
    debt: [{ name: 'debt', score: 100, maxScore: 100, issues: [], summary: 'clean' }],
    deps: [{ name: 'deps', score: 100, maxScore: 100, issues: [], summary: 'clean' }],
  };
  const cats = buildCategories(checkMap);
  const integrity = cats.find(c => c.name === 'integrity');
  // verify gets floor of 20, models stays 100 → avg = 60
  assert.equal(integrity.score, 60, `Integrity score should be 60 (floor applied), got: ${integrity.score}`);
});

test('buildCategories: security check with score 0 is NOT floored', () => {
  const checkMap = {
    security: [
      { name: 'scan', score: 0, maxScore: 100, issues: [{ severity: 'error', message: 'critical', fixable: false }], summary: 'bad' },
      { name: 'secrets', score: 100, maxScore: 100, issues: [], summary: 'clean' },
    ],
    integrity: [{ name: 'verify', score: 100, maxScore: 100, issues: [], summary: 'clean' }],
    debt: [{ name: 'debt', score: 100, maxScore: 100, issues: [], summary: 'clean' }],
    deps: [{ name: 'deps', score: 100, maxScore: 100, issues: [], summary: 'clean' }],
  };
  const cats = buildCategories(checkMap);
  const security = cats.find(c => c.name === 'security');
  // scan=0 (no floor), secrets=100 → avg = 50
  assert.equal(security.score, 50, `Security score should be 50 (no floor for scan), got: ${security.score}`);
});

// ── All non-security check names get the floor ───────────────────────────────

test('applyScoreFloor: all non-security checks get floor', () => {
  const nonSecurityNames = ['models', 'verify', 'ready', 'config', 'debt', 'history', 'diff', 'tests', 'memory', 'receipt', 'deps', 'integrity', 'map'];
  for (const name of nonSecurityNames) {
    const check = { name, score: 5, maxScore: 100, issues: [], summary: 'test' };
    assert.equal(applyScoreFloor(check), 20, `${name} should get floor of 20`);
  }
});
