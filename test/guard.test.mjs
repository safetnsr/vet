import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { checkGuard } = await import('../src/checks/guard.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-guard-'));
}

// 1. clean directory → score 100, no issues
test('checkGuard: clean directory returns score 100', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'index.ts'), 'console.log("hello");\n');
    const result = checkGuard(dir);
    assert.equal(result.name, 'guard');
    assert.equal(result.score, 100);
    assert.equal(result.maxScore, 100);
    assert.equal(result.issues.length, 0);
    assert.ok(result.summary.includes('no destructive patterns found'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 2. SQL DROP TABLE in .sql file → error
test('checkGuard: DROP TABLE in .sql file → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'schema.sql'), 'DROP TABLE users;\n');
    const result = checkGuard(dir);
    assert.ok(result.issues.length > 0);
    const issue = result.issues.find(i => i.message.includes('DROP TABLE'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 3. SQL DROP DATABASE → error
test('checkGuard: DROP DATABASE → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'nuke.sql'), 'DROP DATABASE production;\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('DROP DATABASE'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 4. SQL DELETE FROM without WHERE → error
test('checkGuard: DELETE FROM without WHERE → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'clean.sql'), 'DELETE FROM users;\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('DELETE FROM without WHERE'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 5. SQL DELETE FROM with WHERE → warning
test('checkGuard: DELETE FROM with WHERE → warning', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'clean.sql'), 'DELETE FROM users WHERE id = 1;\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('DELETE FROM with WHERE'));
    assert.ok(issue);
    assert.equal(issue.severity, 'warning');
    // Should NOT have a "without WHERE" error
    const errorIssue = result.issues.find(i => i.message.includes('without WHERE'));
    assert.equal(errorIssue, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 6. SQL TRUNCATE TABLE → error
test('checkGuard: TRUNCATE TABLE → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'truncate.sql'), 'TRUNCATE TABLE sessions;\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('TRUNCATE'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 7. rm -rf in .sh file → error
test('checkGuard: rm -rf in .sh file → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'clean.sh'), '#!/bin/bash\nrm -rf /tmp/data\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('rm -rf'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 8. exec('rm -rf ...') in .ts file → error
test('checkGuard: exec rm -rf in .ts file → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'deploy.ts'), 'exec("rm -rf dist");\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('rm -rf in exec'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 9. execSync containing destructive command → error
test('checkGuard: execSync with rm -rf → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'clean.ts'), 'execSync("rm -rf /tmp/build");\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('rm -rf in exec'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 10. spawn with rm -rf → error
test('checkGuard: spawn with rm -rf → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'run.ts'), 'spawn("rm -rf /var/data");\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('rm -rf in exec'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 11. migration file with DROP but no rollback → warning
test('checkGuard: migration with DROP but no rollback → warning', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'migrations', '001.sql'), 'DROP TABLE old_users;\n');
    const result = checkGuard(dir);
    const migIssue = result.issues.find(i => i.message.includes('migration with destructive'));
    assert.ok(migIssue);
    assert.equal(migIssue.severity, 'warning');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 12. migration file with DROP AND down() function → no migration warning
test('checkGuard: migration with DROP and down() → no migration warning', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'migrations'), { recursive: true });
    writeFileSync(join(dir, 'migrations', '001.ts'), 'export function up() { DROP TABLE old; }\nexport function down() { CREATE TABLE old; }\n');
    const result = checkGuard(dir);
    const migIssue = result.issues.find(i => i.message.includes('migration with destructive'));
    assert.equal(migIssue, undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 13. test files are skipped
test('checkGuard: files in test/ dir are skipped', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'test', 'cleanup.ts'), 'exec("rm -rf /tmp/test");\n');
    writeFileSync(join(dir, 'foo.test.ts'), 'exec("rm -rf /tmp/test");\n');
    const result = checkGuard(dir);
    assert.equal(result.issues.length, 0);
    assert.equal(result.score, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 14. multiple patterns in one file → multiple issues
test('checkGuard: multiple patterns in one file → multiple issues', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'nuke.sql'), 'DROP TABLE users;\nDROP DATABASE prod;\nDELETE FROM logs;\n');
    const result = checkGuard(dir);
    assert.ok(result.issues.length >= 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 15. case insensitivity
test('checkGuard: case insensitive detection', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'lower.sql'), 'drop table users;\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('DROP TABLE'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 16. score deduction correct (15 per error, 5 per warning)
test('checkGuard: score deduction — 15 per error, 5 per warning', () => {
  const dir = makeTmpDir();
  try {
    // 2 errors (DROP TABLE + DELETE without WHERE) = -30, 0 warnings
    writeFileSync(join(dir, 'bad.sql'), 'DROP TABLE x;\nDELETE FROM y;\n');
    const result = checkGuard(dir);
    const errors = result.issues.filter(i => i.severity === 'error').length;
    const warnings = result.issues.filter(i => i.severity === 'warning').length;
    assert.equal(result.score, Math.max(0, 100 - (errors * 15) - (warnings * 5)));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 17. JSON output shape matches CheckResult
test('checkGuard: output matches CheckResult shape', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'ok.ts'), 'const x = 1;\n');
    const result = checkGuard(dir);
    assert.equal(typeof result.name, 'string');
    assert.equal(typeof result.score, 'number');
    assert.equal(typeof result.maxScore, 'number');
    assert.ok(Array.isArray(result.issues));
    assert.equal(typeof result.summary, 'string');
    assert.equal(result.maxScore, 100);
    assert.ok(result.score >= 0 && result.score <= 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 18. shred command in .sh file → error
test('checkGuard: shred in .sh file → error', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'destroy.sh'), '#!/bin/bash\nshred /dev/sda\n');
    const result = checkGuard(dir);
    const issue = result.issues.find(i => i.message.includes('shred'));
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
