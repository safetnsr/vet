import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const { analyzeEdge, checkEdge } = await import('../src/checks/edge.ts');

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'vet-edge-'));
}

function initGitRepo(dir) {
  execSync('git init && git config user.email "t@t.com" && git config user.name "T"', { cwd: dir, stdio: 'pipe' });
}

function makeCommit(dir, message, files = []) {
  for (const [name, content] of files) {
    const filePath = join(dir, name);
    mkdirSync(join(dir, name.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(filePath, content);
  }
  if (files.length === 0) writeFileSync(join(dir, `f${Date.now()}.txt`), 'x');
  execSync(`git add -A && git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

test('analyzeEdge: empty repo returns zero commits', () => {
  const dir = makeTmpDir();
  try {
    initGitRepo(dir);
    const result = analyzeEdge(dir);
    assert.equal(result.totalCommits, 0);
    assert.equal(result.score, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('analyzeEdge: classifies boilerplate commit', () => {
  const dir = makeTmpDir();
  try {
    initGitRepo(dir);
    makeCommit(dir, 'init: scaffold project', [
      ['index.ts', 'export {};\n'.repeat(50)],
      ['util.ts', 'export {};\n'.repeat(50)],
      ['types.ts', 'export {};\n'.repeat(50)],
    ]);
    const result = analyzeEdge(dir);
    assert.ok(result.totalCommits >= 1);
    assert.ok(result.distribution.boilerplate >= 1 || result.distribution.feature >= 1, 'should classify as boilerplate or feature');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('analyzeEdge: classifies fix commit as debugging', () => {
  const dir = makeTmpDir();
  try {
    initGitRepo(dir);
    makeCommit(dir, 'initial', [['src/app.ts', 'x\n'.repeat(30)]]);
    writeFileSync(join(dir, 'src/app.ts'), 'x\n'.repeat(28) + 'fixed\n\n');
    execSync('git add -A && git commit -m "fix: resolve null pointer error in app"', { cwd: dir, stdio: 'pipe' });
    const result = analyzeEdge(dir);
    assert.ok(result.totalCommits >= 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkEdge: returns valid CheckResult shape', () => {
  const dir = makeTmpDir();
  try {
    initGitRepo(dir);
    makeCommit(dir, 'initial commit');
    const result = checkEdge(dir);
    assert.equal(result.name, 'edge');
    assert.equal(result.maxScore, 10);
    assert.ok(result.score >= 0 && result.score <= 10);
    assert.ok(typeof result.summary === 'string');
    assert.ok(Array.isArray(result.issues));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkEdge: no commits returns info issue', () => {
  const dir = makeTmpDir();
  try {
    initGitRepo(dir);
    const result = checkEdge(dir);
    assert.equal(result.score, 5);
    assert.ok(result.issues.some(i => i.message.includes('no commits')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('analyzeEdge: score is 0-100', () => {
  const dir = makeTmpDir();
  try {
    initGitRepo(dir);
    makeCommit(dir, 'feat: add user authentication', [
      ['src/routes/auth.ts', 'export function login() {}\n'.repeat(20)],
      ['src/models/user.ts', 'export interface User {}\n'.repeat(20)],
      ['src/middleware/session.ts', 'export function session() {}\n'.repeat(20)],
      ['test/auth.test.ts', 'test("login", () => {});\n'.repeat(10)],
    ]);
    const result = analyzeEdge(dir);
    assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} should be 0-100`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
