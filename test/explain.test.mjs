import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Import from built output
import { classifyFile, checkExplain, analyzeFiles, runExplainCommand } from '../dist/checks/explain.js';

// ── Helper: create a temp git repo ───────────────────────────────────────────

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'vet-explain-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Initial commit
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Path classification tests ────────────────────────────────────────────────

describe('classifyFile — RISKY paths', () => {
  it('1. detects auth* files as RISKY', () => {
    const r = classifyFile('auth-handler.ts');
    assert.strictEqual(r.tier, 'RISKY');
  });

  it('2. detects payment* files as RISKY', () => {
    const r = classifyFile('payment-service.ts');
    assert.strictEqual(r.tier, 'RISKY');
  });

  it('3. detects migrations/* files as RISKY', () => {
    const r = classifyFile('migrations/001-create-users.sql');
    assert.strictEqual(r.tier, 'RISKY');
  });

  it('4. detects session* files as RISKY', () => {
    const r = classifyFile('session-store.ts');
    assert.strictEqual(r.tier, 'RISKY');
  });

  it('5. detects env* files as RISKY', () => {
    const r = classifyFile('env.production');
    assert.strictEqual(r.tier, 'RISKY');
  });

  it('5b. detects .env files as RISKY', () => {
    const r = classifyFile('.env.local');
    assert.strictEqual(r.tier, 'RISKY');
  });
});

describe('classifyFile — REVIEW paths', () => {
  it('6. detects api/* files as REVIEW', () => {
    const r = classifyFile('api/users.ts');
    assert.strictEqual(r.tier, 'REVIEW');
  });

  it('7. detects routes/* files as REVIEW', () => {
    const r = classifyFile('routes/index.ts');
    assert.strictEqual(r.tier, 'REVIEW');
  });

  it('8. detects middleware/* files as REVIEW', () => {
    const r = classifyFile('middleware/cors.ts');
    assert.strictEqual(r.tier, 'REVIEW');
  });

  it('9. detects db/* files as REVIEW', () => {
    const r = classifyFile('db/connection.ts');
    assert.strictEqual(r.tier, 'REVIEW');
  });
});

describe('classifyFile — SAFE paths', () => {
  it('10. classifies regular files as SAFE', () => {
    assert.strictEqual(classifyFile('utils.ts').tier, 'SAFE');
    assert.strictEqual(classifyFile('README.md').tier, 'SAFE');
    assert.strictEqual(classifyFile('src/components/Button.tsx').tier, 'SAFE');
  });
});

// ── Hunk keyword tests (need real git repos) ────────────────────────────────

describe('hunk keyword scanning', () => {
  let dir;

  before(() => { dir = makeTempRepo(); });
  after(() => { cleanup(dir); });

  it('11. DELETE in removed line bumps to RISKY', () => {
    writeFileSync(join(dir, 'utils.ts'), 'DELETE FROM users;');
    execSync('git add -A && git commit -m "add utils"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'utils.ts'), '// cleaned up');
    execSync('git add -A && git commit -m "remove DELETE"', { cwd: dir, stdio: 'pipe' });

    const files = analyzeFiles(dir, 'HEAD~1');
    const f = files.find(x => x.file === 'utils.ts');
    assert.ok(f, 'utils.ts should be in results');
    assert.strictEqual(f.tier, 'RISKY');
  });

  it('12. DROP in removed line bumps to RISKY', () => {
    writeFileSync(join(dir, 'clean.ts'), 'DROP TABLE users;');
    execSync('git add -A && git commit -m "add clean"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'clean.ts'), '// safe now');
    execSync('git add -A && git commit -m "remove DROP"', { cwd: dir, stdio: 'pipe' });

    const files = analyzeFiles(dir, 'HEAD~1');
    const f = files.find(x => x.file === 'clean.ts');
    assert.ok(f, 'clean.ts should be in results');
    assert.strictEqual(f.tier, 'RISKY');
  });

  it('13. TODO in added line bumps SAFE to REVIEW', () => {
    writeFileSync(join(dir, 'feature.ts'), 'const x = 1;');
    execSync('git add -A && git commit -m "add feature"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'feature.ts'), 'const x = 1;\n// TODO: fix this later');
    execSync('git add -A && git commit -m "add todo"', { cwd: dir, stdio: 'pipe' });

    const files = analyzeFiles(dir, 'HEAD~1');
    const f = files.find(x => x.file === 'feature.ts');
    assert.ok(f, 'feature.ts should be in results');
    assert.strictEqual(f.tier, 'REVIEW');
  });
});

// ── Score calculation tests ──────────────────────────────────────────────────

describe('checkExplain score calculation', () => {
  let dir;

  before(() => { dir = makeTempRepo(); });
  after(() => { cleanup(dir); });

  it('14. 0 risky files = score 100', () => {
    writeFileSync(join(dir, 'readme.md'), 'hello');
    execSync('git add -A && git commit -m "add readme"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'readme.md'), 'hello world');
    execSync('git add -A && git commit -m "update"', { cwd: dir, stdio: 'pipe' });

    const result = checkExplain(dir, 'HEAD~1');
    assert.strictEqual(result.score, 100);
  });

  it('15. 5 risky files = score 25', () => {
    // Create 5 risky files
    for (const name of ['auth.ts', 'session.ts', 'payment.ts', 'billing.ts', 'credential.ts']) {
      writeFileSync(join(dir, name), 'init');
    }
    execSync('git add -A && git commit -m "add risky"', { cwd: dir, stdio: 'pipe' });
    for (const name of ['auth.ts', 'session.ts', 'payment.ts', 'billing.ts', 'credential.ts']) {
      writeFileSync(join(dir, name), 'changed');
    }
    execSync('git add -A && git commit -m "modify risky"', { cwd: dir, stdio: 'pipe' });

    const result = checkExplain(dir, 'HEAD~1');
    assert.strictEqual(result.score, 25);
  });
});

// ── JSON output shape ────────────────────────────────────────────────────────

describe('runExplainCommand', () => {
  let dir;

  before(() => { dir = makeTempRepo(); });
  after(() => { cleanup(dir); });

  it('16. JSON output has correct shape', async () => {
    writeFileSync(join(dir, 'auth.ts'), 'x');
    writeFileSync(join(dir, 'utils.ts'), 'y');
    execSync('git add -A && git commit -m "add files"', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'auth.ts'), 'changed');
    writeFileSync(join(dir, 'utils.ts'), 'changed');
    execSync('git add -A && git commit -m "modify"', { cwd: dir, stdio: 'pipe' });

    // Capture stdout
    const originalLog = console.log;
    let output = '';
    console.log = (msg) => { output += msg; };

    await runExplainCommand('json', dir, 'HEAD~1', false, false);

    console.log = originalLog;

    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed.risky), 'has risky array');
    assert.ok(Array.isArray(parsed.review), 'has review array');
    assert.ok(Array.isArray(parsed.safe), 'has safe array');
    assert.ok(parsed.summary, 'has summary');
    assert.strictEqual(typeof parsed.summary.total, 'number');
    assert.strictEqual(typeof parsed.summary.risky, 'number');
    assert.strictEqual(typeof parsed.summary.review, 'number');
    assert.strictEqual(typeof parsed.summary.safe, 'number');
  });

  it('17. empty diff produces clean output', async () => {
    // No changes since last commit
    const originalLog = console.log;
    const lines = [];
    console.log = (msg) => { lines.push(msg); };

    await runExplainCommand('ascii', dir, 'HEAD~0', false, false);

    console.log = originalLog;

    const allOutput = lines.join('\n');
    assert.ok(allOutput.includes('no changed files'), 'should mention no changed files');
  });
});
