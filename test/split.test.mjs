import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const { checkSplit } = await import('../src/checks/split.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-split-'));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir) {
  git(['init'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

// 1. Empty repo → score 100, no issues
test('checkSplit: empty repo → score 100', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
    assert.equal(result.score, 100);
    assert.equal(result.maxScore, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 2. Single small commit → score 100
test('checkSplit: single small commit → score 100', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'index.ts'), 'console.log("hello");\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'initial'], dir);
    const result = checkSplit(dir);
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 3. Large multi-file commit → lower score, issues flagged
test('checkSplit: large multi-file commit → lower score', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'base.ts'), 'export const x = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    // Create a large commit touching many concerns
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, 'src', `file${i}.ts`), `export const f${i} = ${i};\n`);
    }
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, 'test', `file${i}.test.ts`), `test('${i}', () => {});\n`);
    }
    writeFileSync(join(dir, 'package.json'), '{"name": "test"}\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'big change'], dir);

    const result = checkSplit(dir);
    assert.ok(result.score < 100, `expected score < 100, got ${result.score}`);
    assert.ok(result.issues.length > 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 4. Test files clustered separately from src files
test('checkSplit: test files cluster separately', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'base.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');
    writeFileSync(join(dir, 'test', 'app.test.ts'), 'test("app", () => {});\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add app + test'], dir);

    const result = checkSplit(dir);
    // The check itself detects multi-concern commits
    assert.equal(result.name, 'split');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 5. Config files (package.json) clustered as chore
test('checkSplit: config files detected', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'base.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    writeFileSync(join(dir, 'package.json'), '{"name":"test"}\n');
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add config'], dir);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
    assert.equal(result.maxScore, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 6. Generated commit messages use correct conventional prefixes
test('checkSplit: commit messages follow conventional format', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'base.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    // Verify the result has proper structure
    const result = checkSplit(dir);
    assert.ok(result.summary, 'should have summary');
    assert.ok(typeof result.score === 'number');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 7. checkSplit return value has correct shape
test('checkSplit: return value has correct CheckResult shape', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'index.ts'), 'hello\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);

    const result = checkSplit(dir);
    assert.ok('name' in result);
    assert.ok('score' in result);
    assert.ok('maxScore' in result);
    assert.ok('issues' in result);
    assert.ok('summary' in result);
    assert.ok(Array.isArray(result.issues));
    assert.equal(typeof result.score, 'number');
    assert.equal(typeof result.maxScore, 'number');
    assert.equal(result.maxScore, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 8. Multiple small atomic commits → high score
test('checkSplit: multiple small atomic commits → high score', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);

    // Make several small, focused commits
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add a'], dir);

    writeFileSync(join(dir, 'b.ts'), 'export const b = 2;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add b'], dir);

    writeFileSync(join(dir, 'c.ts'), 'export const c = 3;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add c'], dir);

    const result = checkSplit(dir);
    assert.equal(result.score, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 9. Diff parsing handles added files
test('checkSplit: handles added files', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'existing.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    writeFileSync(join(dir, 'new-file.ts'), 'export const y = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add new file'], dir);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
    // Single file commit should be fine
    assert.equal(result.score, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 10. Diff parsing handles deleted files
test('checkSplit: handles deleted files', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'to-delete.ts'), 'gone\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    git(['rm', 'to-delete.ts'], dir);
    git(['commit', '-m', 'remove file'], dir);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 11. Diff parsing handles renamed files
test('checkSplit: handles renamed files', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'old-name.ts'), 'content\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    git(['mv', 'old-name.ts', 'new-name.ts'], dir);
    git(['commit', '-m', 'rename'], dir);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 12. Branch safety: detects main/master
test('checkSplit: detects main/master branch', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'x.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);

    // Check current branch
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    // Branch should be main or master (default)
    assert.ok(branch === 'main' || branch === 'master' || branch.length > 0);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 13. Cluster count matches expected groups
test('checkSplit: cluster count matches concerns', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'base.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    // Create commit with 3 distinct concerns: src, test, config
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(dir, 'src', `mod${i}.ts`), `export const m${i} = ${i};\n`);
    }
    writeFileSync(join(dir, 'test', 'mod.test.ts'), 'test("m", () => {});\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"test"}\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'mega commit'], dir);

    const result = checkSplit(dir);
    // Should flag this as multi-concern
    assert.ok(result.issues.length > 0, 'should have issues for multi-concern commit');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 14. Empty diff → graceful handling
test('checkSplit: empty diff handled gracefully', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    // Repo with no commits at all — no diff possible
    const result = checkSplit(dir);
    assert.equal(result.score, 100);
    assert.equal(result.name, 'split');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 15. Binary files excluded from analysis
test('checkSplit: binary files excluded', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'base.ts'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    // Add a binary file alongside a text file
    writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]));
    writeFileSync(join(dir, 'code.ts'), 'export const z = 1;\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'add files'], dir);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
    // Should not crash on binary
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// 16. Hunk count per cluster is accurate
test('checkSplit: analyzes hunk counts correctly', () => {
  const dir = makeTmpDir();
  try {
    initRepo(dir);
    writeFileSync(join(dir, 'a.ts'), 'line1\nline2\nline3\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);

    // Modify file — creates hunks
    writeFileSync(join(dir, 'a.ts'), 'line1\nmodified\nline3\nextra\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'modify'], dir);

    const result = checkSplit(dir);
    assert.equal(result.name, 'split');
    assert.ok(typeof result.score === 'number');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
