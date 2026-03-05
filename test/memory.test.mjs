import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { checkMemory } = await import('../src/checks/memory.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-memory-'));
}

function withPkg(dir, deps = {}, devDeps = {}) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-pkg',
    dependencies: deps,
    devDependencies: devDeps,
  }));
}

// 1. clean repo (no memory files) → score 100
test('checkMemory: clean repo returns score 100', () => {
  const dir = makeTmpDir();
  try {
    const result = checkMemory(dir);
    assert.equal(result.name, 'memory');
    assert.equal(result.score, 100);
    assert.equal(result.maxScore, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 2. stale @scope/package in CLAUDE.md → score < 100, warning issue
test('checkMemory: stale scoped package reference', () => {
  const dir = makeTmpDir();
  try {
    withPkg(dir, { 'express': '^4.0.0' });
    writeFileSync(join(dir, 'CLAUDE.md'), 'We use @safetnsr/nonexistent for tooling');
    const result = checkMemory(dir);
    assert.ok(result.score < 100, `score should be < 100, got ${result.score}`);
    assert.ok(result.issues.some(i => i.severity === 'warning' && i.message.includes('@safetnsr/nonexistent')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 3. broken absolute path /var/www/nonexistent → error issue
test('checkMemory: broken absolute path', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Project lives at /var/www/nonexistent-vet-test-path');
    const result = checkMemory(dir);
    assert.ok(result.issues.some(i => i.severity === 'error' && i.message.includes('/var/www/nonexistent-vet-test-path')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 4. broken relative path ./src/nonexistent.ts → error issue
test('checkMemory: broken relative path', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Main entry: ./src/nonexistent.ts');
    const result = checkMemory(dir);
    assert.ok(result.issues.some(i => i.severity === 'error' && i.message.includes('./src/nonexistent.ts')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 5. valid path that exists → no false positive
test('checkMemory: valid path produces no issue', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), '// hi');
    writeFileSync(join(dir, 'CLAUDE.md'), 'Main entry: ./src/index.ts');
    const result = checkMemory(dir);
    const pathIssues = result.issues.filter(i => i.message.includes('./src/index.ts'));
    assert.equal(pathIssues.length, 0, 'should not flag existing path');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 6. contradiction: vitest in CLAUDE.md + node:test in AGENTS.md → warning
test('checkMemory: contradiction between files', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'We use vitest for testing');
    writeFileSync(join(dir, 'AGENTS.md'), 'Tests run with node:test');
    const result = checkMemory(dir);
    assert.ok(result.issues.some(i => i.severity === 'warning' && i.message.includes('Contradiction')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 7. no contradiction if same tool in both → no issue
test('checkMemory: same tool in multiple files is fine', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'We use vitest for testing');
    writeFileSync(join(dir, 'AGENTS.md'), 'Run vitest before pushing');
    const result = checkMemory(dir);
    const contradictions = result.issues.filter(i => i.message.includes('Contradiction'));
    assert.equal(contradictions.length, 0, 'same tool should not trigger contradiction');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 8. bloat: file >5000 chars, <3 facts → info issue
test('checkMemory: bloated file detected', () => {
  const dir = makeTmpDir();
  try {
    const padding = 'This is some filler text without any real facts.\n'.repeat(200);
    writeFileSync(join(dir, 'CLAUDE.md'), padding);
    const result = checkMemory(dir);
    assert.ok(result.issues.some(i => i.severity === 'info' && i.message.includes('Bloated')));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 9. memory subdirectory files scanned → finds issues in memory/NOW.md
test('checkMemory: scans memory subdirectory', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'NOW.md'), 'Deploy to /var/www/nonexistent-subdir-test');
    const result = checkMemory(dir);
    assert.ok(result.issues.some(i => i.file?.includes('memory') && i.severity === 'error'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 10. missing CLAUDE.md → no crash, score 100
test('checkMemory: missing CLAUDE.md does not crash', () => {
  const dir = makeTmpDir();
  try {
    // Create an AGENTS.md but no CLAUDE.md
    writeFileSync(join(dir, 'AGENTS.md'), 'Some clean content with no issues');
    const result = checkMemory(dir);
    assert.equal(result.name, 'memory');
    assert.ok(typeof result.score === 'number');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 11. summary string is present and non-empty
test('checkMemory: summary is present and non-empty', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Clean file');
    const result = checkMemory(dir);
    assert.ok(result.summary.length > 0, 'summary should be non-empty');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 12. --json compatible: result has name, score, maxScore, issues, summary
test('checkMemory: result shape is json-compatible', () => {
  const dir = makeTmpDir();
  try {
    const result = checkMemory(dir);
    assert.ok('name' in result);
    assert.ok('score' in result);
    assert.ok('maxScore' in result);
    assert.ok('issues' in result);
    assert.ok('summary' in result);
    assert.ok(Array.isArray(result.issues));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 13. issues have file property set
test('checkMemory: issues have file property', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Deploy to /var/www/nonexistent-file-prop-test');
    const result = checkMemory(dir);
    for (const issue of result.issues) {
      assert.ok(issue.file, `issue "${issue.message}" should have file property`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 14. issues have line property set
test('checkMemory: issues have line property', () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'line 1\nDeploy to /var/www/nonexistent-line-prop-test\nline 3');
    const result = checkMemory(dir);
    for (const issue of result.issues) {
      assert.ok(typeof issue.line === 'number', `issue "${issue.message}" should have numeric line`);
      assert.ok(issue.line > 0, 'line should be positive');
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 15. fixHint present on issues
test('checkMemory: issues have fixHint', () => {
  const dir = makeTmpDir();
  try {
    withPkg(dir, { 'express': '^4.0.0' });
    writeFileSync(join(dir, 'CLAUDE.md'), 'We use @safetnsr/nonexistent and deploy to /var/www/nonexistent-hint-test');
    const result = checkMemory(dir);
    assert.ok(result.issues.length > 0, 'should have issues');
    for (const issue of result.issues) {
      assert.ok(issue.fixHint, `issue "${issue.message}" should have fixHint`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 16. score never goes below 0
test('checkMemory: score floors at 0', () => {
  const dir = makeTmpDir();
  try {
    // Create many broken paths to push score way below 0
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`Path: /var/www/nonexistent-floor-test-${i}`);
    }
    writeFileSync(join(dir, 'CLAUDE.md'), lines.join('\n'));
    const result = checkMemory(dir);
    assert.ok(result.score >= 0, `score should be >= 0, got ${result.score}`);
    assert.equal(result.score, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
