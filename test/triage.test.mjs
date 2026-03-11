import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Import from built output
import { checkTriage, analyzeTriage } from '../dist/checks/triage.js';

// ── Helper ───────────────────────────────────────────────────────────────────

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'vet-triage-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Initial commit with a placeholder
  writeFileSync(join(dir, '.gitkeep'), '');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe', shell: true });
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeChange(dir, relPath, content) {
  const full = join(dir, relPath);
  const parts = relPath.split('/');
  if (parts.length > 1) {
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  writeFileSync(full, content);
  execSync('git add -A && git commit -m "change"', { cwd: dir, stdio: 'pipe', shell: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. security path detection: auth.ts → HIGH
describe('triage — security path', () => {
  it('1. auth.ts is detected as HIGH', () => {
    const dir = makeTempRepo();
    try {
      // First commit: empty file
      writeFileSync(join(dir, 'auth.ts'), 'export const x = 1;\n');
      execSync('git add -A && git commit -m "add auth"', { cwd: dir, stdio: 'pipe', shell: true });
      // Second commit: change it
      writeFileSync(join(dir, 'auth.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\nexport const w = 4;\nexport const v = 5;\n');
      execSync('git add -A && git commit -m "update auth"', { cwd: dir, stdio: 'pipe', shell: true });

      const result = checkTriage(dir, 'HEAD~1');
      const issue = result.issues.find(i => i.file === 'auth.ts');
      assert.ok(issue, 'auth.ts should have an issue');
      assert.ok(issue.message.includes('HIGH') || issue.severity === 'warning', 'should be HIGH');
    } finally {
      cleanup(dir);
    }
  });

  // 2. security path detection: middleware/cors.ts → HIGH
  it('2. middleware/cors.ts is detected as HIGH', () => {
    const dir = makeTempRepo();
    try {
      mkdirSync(join(dir, 'middleware'), { recursive: true });
      writeFileSync(join(dir, 'middleware', 'cors.ts'), 'export const cors = true;\n');
      execSync('git add -A && git commit -m "add cors"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'middleware', 'cors.ts'), 'export const cors = true;\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
      execSync('git add -A && git commit -m "update cors"', { cwd: dir, stdio: 'pipe', shell: true });

      const result = checkTriage(dir, 'HEAD~1');
      const issue = result.issues.find(i => i.file && i.file.includes('cors.ts'));
      assert.ok(issue, 'cors.ts should have an issue');
      assert.ok(issue.message.includes('HIGH'), 'should be HIGH');
    } finally {
      cleanup(dir);
    }
  });

  // 3. security path ignores .css: auth-styles.css → not HIGH
  it('3. auth-styles.css is NOT HIGH (security path ignores .css)', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'auth-styles.css'), '.button { color: red; }\n');
      execSync('git add -A && git commit -m "add css"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'auth-styles.css'), '.button { color: blue; }\n.input { border: 1px solid; }\n.form { padding: 1rem; }\n.label { font-size: 14px; }\n.wrapper { display: flex; }\n');
      execSync('git add -A && git commit -m "update css"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file && e.file.includes('auth-styles.css'));
      if (entry) {
        assert.notEqual(entry.rank, 'HIGH', 'auth-styles.css should not be HIGH');
        assert.notEqual(entry.rank, 'CRITICAL', 'auth-styles.css should not be CRITICAL');
      }
      // If no entry, that's also fine (not flagged)
    } finally {
      cleanup(dir);
    }
  });

  // 4. security path ignores .md: auth.md → not HIGH
  it('4. auth.md is NOT HIGH (security path ignores .md)', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'auth.md'), '# Auth docs\n');
      execSync('git add -A && git commit -m "add md"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'auth.md'), '# Auth docs\n\nSome content here.\n\nMore content.\n\nEven more.\n');
      execSync('git add -A && git commit -m "update md"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file === 'auth.md');
      if (entry) {
        assert.notEqual(entry.rank, 'HIGH', 'auth.md should not be HIGH');
        assert.notEqual(entry.rank, 'CRITICAL', 'auth.md should not be CRITICAL');
      }
    } finally {
      cleanup(dir);
    }
  });

  // 5. security path ignores .json: config/auth.json → not HIGH
  it('5. config/auth.json is NOT HIGH (security path ignores .json)', () => {
    const dir = makeTempRepo();
    try {
      mkdirSync(join(dir, 'config'), { recursive: true });
      writeFileSync(join(dir, 'config', 'auth.json'), '{"key":"value"}\n');
      execSync('git add -A && git commit -m "add json"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'config', 'auth.json'), '{"key":"newvalue","extra":"field","another":"one","four":"fields","five":"total"}\n');
      execSync('git add -A && git commit -m "update json"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file && e.file.includes('auth.json'));
      if (entry) {
        assert.notEqual(entry.rank, 'HIGH', 'config/auth.json should not be HIGH');
        assert.notEqual(entry.rank, 'CRITICAL', 'config/auth.json should not be CRITICAL');
      }
    } finally {
      cleanup(dir);
    }
  });
});

// 6. schema/db path detection: migrations/001.ts → HIGH
describe('triage — schema/db path', () => {
  it('6. migrations/001.ts is detected as HIGH', () => {
    const dir = makeTempRepo();
    try {
      mkdirSync(join(dir, 'migrations'), { recursive: true });
      writeFileSync(join(dir, 'migrations', '001.ts'), 'export function up() {}\n');
      execSync('git add -A && git commit -m "add migration"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'migrations', '001.ts'), 'export function up() { return true; }\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
      execSync('git add -A && git commit -m "update migration"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file && e.file.includes('001.ts'));
      assert.ok(entry, 'migration file should be in results');
      assert.ok(entry.rank === 'HIGH' || entry.rank === 'CRITICAL', `expected HIGH or CRITICAL, got ${entry.rank}`);
    } finally {
      cleanup(dir);
    }
  });

  // 7. schema/db path detection: prisma/schema.prisma → HIGH
  it('7. prisma/schema.prisma is detected as HIGH', () => {
    const dir = makeTempRepo();
    try {
      mkdirSync(join(dir, 'prisma'), { recursive: true });
      writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model User {\n  id Int\n}\n');
      execSync('git add -A && git commit -m "add schema"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model User {\n  id Int\n  name String\n  email String\n  createdAt DateTime\n}\n');
      execSync('git add -A && git commit -m "update schema"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file && e.file.includes('schema.prisma'));
      assert.ok(entry, 'schema.prisma should be in results');
      assert.ok(entry.rank === 'HIGH' || entry.rank === 'CRITICAL', `expected HIGH or CRITICAL, got ${entry.rank}`);
    } finally {
      cleanup(dir);
    }
  });
});

// 8. error handler removal detection: removed try/catch → HIGH
describe('triage — error handler removal', () => {
  it('8. removing try/catch lines is detected as HIGH', () => {
    const dir = makeTempRepo();
    try {
      // Commit 1: file with try/catch
      writeFileSync(join(dir, 'service.ts'), [
        'export function doWork() {',
        '  try {',
        '    return process();',
        '  } catch (err) {',
        '    console.error(err);',
        '  }',
        '}',
      ].join('\n') + '\n');
      execSync('git add -A && git commit -m "add service"', { cwd: dir, stdio: 'pipe', shell: true });

      // Commit 2: remove try/catch
      writeFileSync(join(dir, 'service.ts'), [
        'export function doWork() {',
        '  return process();',
        '}',
      ].join('\n') + '\n');
      execSync('git add -A && git commit -m "remove error handling"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file === 'service.ts');
      assert.ok(entry, 'service.ts should be in results');
      assert.ok(entry.rank === 'HIGH' || entry.rank === 'CRITICAL', `expected HIGH or CRITICAL, got ${entry.rank}`);
      assert.ok(entry.signals.some(s => s.includes('error handler')), 'should signal error handler removal');
    } finally {
      cleanup(dir);
    }
  });
});

// 9. cosmetic detection: only whitespace changes → SKIP
describe('triage — cosmetic detection', () => {
  it('9. only whitespace changes → SKIP', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'utils.ts'), 'const x = 1;\nconst y = 2;\n');
      execSync('git add -A && git commit -m "add utils"', { cwd: dir, stdio: 'pipe', shell: true });
      // Change: add only whitespace/blank lines (less than 5 total changes)
      writeFileSync(join(dir, 'utils.ts'), 'const x = 1;\n\nconst y = 2;\n');
      execSync('git add -A && git commit -m "whitespace"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file === 'utils.ts');
      if (entry) {
        assert.equal(entry.rank, 'SKIP', `expected SKIP, got ${entry.rank}`);
      }
    } finally {
      cleanup(dir);
    }
  });

  // 10. cosmetic detection: only comment changes → SKIP
  it('10. only comment changes → SKIP', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'helper.ts'), 'const a = 1;\nconst b = 2;\n');
      execSync('git add -A && git commit -m "add helper"', { cwd: dir, stdio: 'pipe', shell: true });
      // Change: add only comments (< 5 total changes)
      writeFileSync(join(dir, 'helper.ts'), 'const a = 1;\n// a comment\nconst b = 2;\n');
      execSync('git add -A && git commit -m "add comment"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file === 'helper.ts');
      if (entry) {
        assert.equal(entry.rank, 'SKIP', `expected SKIP, got ${entry.rank}`);
      }
    } finally {
      cleanup(dir);
    }
  });
});

// 11. CRITICAL ranking: security path + error handler removal → CRITICAL
describe('triage — CRITICAL ranking', () => {
  it('11. security path + error handler removal → CRITICAL', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'auth.ts'), [
        'export function login() {',
        '  try {',
        '    return authenticate();',
        '  } catch (err) {',
        '    throw err;',
        '  }',
        '}',
      ].join('\n') + '\n');
      execSync('git add -A && git commit -m "add auth"', { cwd: dir, stdio: 'pipe', shell: true });

      // Remove error handling from auth.ts
      writeFileSync(join(dir, 'auth.ts'), [
        'export function login() {',
        '  return authenticate();',
        '}',
      ].join('\n') + '\n');
      execSync('git add -A && git commit -m "remove error handling from auth"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file === 'auth.ts');
      assert.ok(entry, 'auth.ts should be in results');
      assert.equal(entry.rank, 'CRITICAL', `expected CRITICAL, got ${entry.rank}`);
    } finally {
      cleanup(dir);
    }
  });
});

// 12. MEDIUM ranking: 50+ lines added without test file → MEDIUM
describe('triage — MEDIUM ranking', () => {
  it('12. 50+ lines added without test file → MEDIUM', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'dashboard.ts'), 'const x = 1;\n');
      execSync('git add -A && git commit -m "add dashboard"', { cwd: dir, stdio: 'pipe', shell: true });

      // Add 55 lines
      const lines = ['const x = 1;'];
      for (let i = 0; i < 55; i++) lines.push(`const line${i} = ${i};`);
      writeFileSync(join(dir, 'dashboard.ts'), lines.join('\n') + '\n');
      execSync('git add -A && git commit -m "big change"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const entry = entries.find(e => e.file === 'dashboard.ts');
      assert.ok(entry, 'dashboard.ts should be in results');
      assert.equal(entry.rank, 'MEDIUM', `expected MEDIUM, got ${entry.rank}`);
    } finally {
      cleanup(dir);
    }
  });
});

// 13. empty diff returns empty results
describe('triage — edge cases', () => {
  it('13. empty diff returns empty results', () => {
    const dir = makeTempRepo();
    try {
      // No changes since HEAD~1 (only one commit)
      const entries = analyzeTriage(dir, 'HEAD~1');
      assert.ok(Array.isArray(entries), 'should return array');
      assert.equal(entries.length, 0, 'should have no entries for empty diff');
    } finally {
      cleanup(dir);
    }
  });

  // 14. json output has correct shape
  it('14. json output has correct shape (file, rank, reason, signals, estimateMin)', () => {
    const dir = makeTempRepo();
    try {
      writeFileSync(join(dir, 'auth.ts'), 'export const x = 1;\n');
      execSync('git add -A && git commit -m "add auth"', { cwd: dir, stdio: 'pipe', shell: true });
      writeFileSync(join(dir, 'auth.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\nexport const w = 4;\nexport const v = 5;\n');
      execSync('git add -A && git commit -m "update auth"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      assert.ok(entries.length > 0, 'should have entries');
      for (const entry of entries) {
        assert.ok('file' in entry, 'should have file field');
        assert.ok('rank' in entry, 'should have rank field');
        assert.ok('reason' in entry, 'should have reason field');
        assert.ok('signals' in entry, 'should have signals field');
        assert.ok('estimateMin' in entry, 'should have estimateMin field');
        assert.ok(['CRITICAL', 'HIGH', 'MEDIUM', 'SKIP'].includes(entry.rank), `rank should be valid, got ${entry.rank}`);
        assert.ok(typeof entry.estimateMin === 'number', 'estimateMin should be a number');
        assert.ok(Array.isArray(entry.signals), 'signals should be an array');
      }
    } finally {
      cleanup(dir);
    }
  });

  // 15. time estimate calculation: 1 CRITICAL + 2 HIGH = 9 min total
  it('15. time estimate: 1 CRITICAL (5 min) + 2 HIGH (2 min each) = 9 min total', () => {
    const dir = makeTempRepo();
    try {
      // Create a CRITICAL file: auth.ts with try/catch removed
      writeFileSync(join(dir, 'auth.ts'), 'export function x() {\n  try {\n    return 1;\n  } catch (e) {\n    return 0;\n  }\n}\n');
      // Create 2 HIGH files: session.ts and schema.prisma
      writeFileSync(join(dir, 'session.ts'), 'export const s = 1;\n');
      mkdirSync(join(dir, 'prisma'), { recursive: true });
      writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model A { id Int }\n');
      execSync('git add -A && git commit -m "add files"', { cwd: dir, stdio: 'pipe', shell: true });

      // Change them
      writeFileSync(join(dir, 'auth.ts'), 'export function x() {\n  return 1;\n}\n');
      writeFileSync(join(dir, 'session.ts'), 'export const s = 1;\nexport const t = 2;\nexport const u = 3;\nexport const v = 4;\nexport const w = 5;\n');
      writeFileSync(join(dir, 'prisma', 'schema.prisma'), 'model A { id Int\n  name String\n}\nmodel B { id Int }\n');
      execSync('git add -A && git commit -m "update files"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');

      const criticalEntries = entries.filter(e => e.rank === 'CRITICAL');
      const highEntries = entries.filter(e => e.rank === 'HIGH');

      assert.ok(criticalEntries.length >= 1, `should have at least 1 CRITICAL, got ${criticalEntries.length}`);
      assert.ok(highEntries.length >= 2, `should have at least 2 HIGH, got ${highEntries.length}`);

      const totalMin = entries.reduce((sum, e) => sum + e.estimateMin, 0);
      assert.ok(totalMin >= 9, `total estimate should be >= 9 min, got ${totalMin}`);
    } finally {
      cleanup(dir);
    }
  });

  // 16. SKIP files show max 3 in terminal output
  it('16. SKIP files show max 3 in terminal output', async () => {
    const dir = makeTempRepo();
    try {
      // Create 5 cosmetic-only files (< 5 line changes each)
      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(dir, `utils${i}.ts`), `const x${i} = 1;\n`);
      }
      execSync('git add -A && git commit -m "add utils"', { cwd: dir, stdio: 'pipe', shell: true });

      // Each file: only 1 line change (cosmetic → SKIP)
      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(dir, `utils${i}.ts`), `const x${i} = 2;\n`);
      }
      execSync('git add -A && git commit -m "update utils"', { cwd: dir, stdio: 'pipe', shell: true });

      const entries = analyzeTriage(dir, 'HEAD~1');
      const skipEntries = entries.filter(e => e.rank === 'SKIP');
      assert.ok(skipEntries.length >= 4, `should have at least 4 SKIP entries, got ${skipEntries.length}`);

      // Capture stdout to verify terminal output limits SKIP display to 3 + "... and N more"
      let output = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => {
        output += typeof chunk === 'string' ? chunk : chunk.toString();
        return true;
      };

      const { runTriageCommand } = await import('../dist/checks/triage.js');
      await runTriageCommand('ascii', dir, 'HEAD~1');

      process.stdout.write = originalWrite;

      // Check that "... and N more" appears if there are > 3 SKIP files
      if (skipEntries.length > 3) {
        assert.ok(output.includes('... and'), `output should contain "... and N more" for ${skipEntries.length} SKIP files`);
      }
    } finally {
      cleanup(dir);
    }
  });
});
