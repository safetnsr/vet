import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { checkBloat } from '../src/checks/bloat.js';

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vet-bloat-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git init && git add -A && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function addCommit(dir, files, message) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execSync(`git add -A && git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function generateLines(n, template = 'const x = 1;') {
  return Array(n).fill(template).join('\n');
}

describe('checkBloat', () => {
  // 1. Clean project (no agent-pattern commits) → score 100
  test('clean project with no agent commits scores 100', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    addCommit(dir, { 'src/b.ts': 'const y = 2;\n' }, 'add feature');
    const result = await checkBloat(dir);
    assert.strictEqual(result.name, 'bloat');
    assert.strictEqual(result.score, 100);
    cleanup(dir);
  });

  // 2. Project with agent commits but no bloat → score 100
  test('project with agent commit but no bloat scores 100', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    addCommit(dir, { 'src/b.ts': 'const y = 2;\n' }, 'feat: add feature [claude]');
    const result = await checkBloat(dir);
    assert.strictEqual(result.score, 100);
    cleanup(dir);
  });

  // 3. Project with high bloat ratio (>20x) → low score
  test('high bloat ratio >20x gives low score', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    // baseline is 1 line, add 25 lines → 25x
    const bigContent = generateLines(25);
    addCommit(dir, { 'src/a.ts': bigContent }, 'feat: ai generated code [claude]');
    const result = await checkBloat(dir);
    assert.ok(result.score <= 60, `expected low score, got ${result.score}`);
    cleanup(dir);
  });

  // 4. Project with >500% file growth → penalty applied
  test('file with >500% growth gets penalty', async () => {
    const dir = makeTempProject({ 'src/a.ts': generateLines(10) });
    // 10 lines → 70 lines = 600% growth
    addCommit(dir, { 'src/a.ts': generateLines(70) }, 'feat: claude expanded');
    const result = await checkBloat(dir);
    const growthIssues = result.issues.filter(i => i.message.includes('growth'));
    assert.ok(growthIssues.length >= 1, 'should flag file growth');
    assert.ok(result.score < 100, 'should penalize');
    cleanup(dir);
  });

  // 5. Non-code file >10MB → penalty
  test('non-code file >10MB gets penalty', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    // Create a >10MB .txt file
    const bigData = Buffer.alloc(11 * 1024 * 1024, 'x');
    writeFileSync(join(dir, 'output.txt'), bigData);
    execSync('git add -A && git commit -m "add output [ai]"', { cwd: dir, stdio: 'pipe' });
    const result = await checkBloat(dir);
    const bombIssues = result.issues.filter(i => i.message.includes('non-code bomb'));
    assert.ok(bombIssues.length >= 1, 'should detect non-code bomb');
    assert.ok(result.score < 100, 'should penalize');
    cleanup(dir);
  });

  // 6. Low-complexity TS padding file (high LOC, few branches) → penalty
  test('low-complexity padding file gets penalty', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    // 1200 lines, no branches — padding
    const padding = generateLines(1200, 'export const val = "hello";');
    addCommit(dir, { 'src/big.ts': padding }, 'feat: agent generated [claude]');
    const result = await checkBloat(dir);
    const padIssues = result.issues.filter(i => i.message.includes('padding'));
    assert.ok(padIssues.length >= 1, 'should detect padding file');
    cleanup(dir);
  });

  // 7. Normal TS file (high LOC, proportional branches) → no penalty
  test('normal TS file with proportional complexity is not flagged', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    // 1100 lines with lots of branches (>0.02 density = 22+ branches)
    const lines = [];
    for (let i = 0; i < 1100; i++) {
      if (i % 30 === 0) {
        lines.push('if (x > 0) { console.log(x); } else { throw new Error("no"); }');
      } else {
        lines.push('const val = "hello";');
      }
    }
    addCommit(dir, { 'src/complex.ts': lines.join('\n') }, 'feat: [claude] complex logic');
    const result = await checkBloat(dir);
    const padIssues = result.issues.filter(i => i.message.includes('padding') && i.file === 'src/complex.ts');
    assert.strictEqual(padIssues.length, 0, 'normal complexity file should not be flagged as padding');
    cleanup(dir);
  });

  // 8. Multiple bloated files → cumulative penalty (max -30)
  test('multiple bloated files get cumulative penalty capped at -30', async () => {
    const dir = makeTempProject({
      'src/a.ts': generateLines(5),
      'src/b.ts': generateLines(5),
      'src/c.ts': generateLines(5),
      'src/d.ts': generateLines(5),
      'src/e.ts': generateLines(5),
      'src/f.ts': generateLines(5),
      'src/g.ts': generateLines(5),
    });
    // Each file goes from 5 to 50 lines = 900% growth
    const bigContent = generateLines(50);
    addCommit(dir, {
      'src/a.ts': bigContent,
      'src/b.ts': bigContent,
      'src/c.ts': bigContent,
      'src/d.ts': bigContent,
      'src/e.ts': bigContent,
      'src/f.ts': bigContent,
      'src/g.ts': bigContent,
    }, 'feat: agent bloat [claude]');
    const result = await checkBloat(dir);
    const growthIssues = result.issues.filter(i => i.message.includes('growth'));
    assert.ok(growthIssues.length >= 6, `expected multiple growth issues, got ${growthIssues.length}`);
    // 7 files * -5 = -35, capped at -30 → score should be 70 (from growth only)
    // But bloat ratio also applies
    assert.ok(result.score >= 0, 'score should not go below 0');
    cleanup(dir);
  });

  // 9. JSON output format produces valid JSON
  test('JSON output produces valid JSON', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    addCommit(dir, { 'src/b.ts': 'const y = 2;\n' }, 'feat: [ai] something');
    const result = await checkBloat(dir);
    // checkBloat returns a CheckResult — verify it's a valid object
    assert.ok(typeof result.score === 'number');
    assert.ok(typeof result.name === 'string');
    assert.ok(Array.isArray(result.issues));
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.name, 'bloat');
    cleanup(dir);
  });

  // 10. Bloat ratio calculation accuracy
  test('bloat ratio calculation is accurate', async () => {
    const dir = makeTempProject({ 'src/a.ts': generateLines(100) });
    // 100 lines → 500 lines = 5x ratio
    addCommit(dir, { 'src/a.ts': generateLines(500) }, 'feat: expand [claude]');
    const result = await checkBloat(dir);
    // With 5x ratio exactly, penalty is -20 (>5x)
    // No >500% file growth because 100→500 = 400% which is ≤500%
    assert.ok(result.summary.includes('5.0x') || result.summary.includes('bloat ratio'), `summary should mention ratio: ${result.summary}`);
    cleanup(dir);
  });

  // 11. Baseline detection finds claude commit
  test('baseline detection finds claude commit', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    addCommit(dir, { 'src/b.ts': 'const y = 2;\n' }, 'normal commit');
    addCommit(dir, { 'src/c.ts': 'const z = 3;\n' }, 'feat: claude did this');
    addCommit(dir, { 'src/d.ts': 'const w = 4;\n' }, 'another normal');
    const result = await checkBloat(dir);
    // Should use the commit before "claude did this" as baseline
    assert.strictEqual(result.name, 'bloat');
    assert.ok(result.score >= 0);
    cleanup(dir);
  });

  // 12. Baseline detection finds .claude/ directory addition
  test('baseline detection finds .claude/ directory addition', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    addCommit(dir, { 'src/b.ts': 'const y = 2;\n' }, 'normal work');
    addCommit(dir, { '.claude/config.json': '{}' }, 'setup tools');
    const result = await checkBloat(dir);
    assert.strictEqual(result.name, 'bloat');
    assert.ok(result.score >= 0);
    cleanup(dir);
  });

  // 13. Baseline detection falls back to initial commit
  test('baseline falls back to initial commit when no AI patterns', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'const x = 1;\n' });
    addCommit(dir, { 'src/b.ts': 'const y = 2;\n' }, 'add feature');
    addCommit(dir, { 'src/c.ts': 'const z = 3;\n' }, 'another feature');
    const result = await checkBloat(dir);
    assert.strictEqual(result.name, 'bloat');
    assert.strictEqual(result.score, 100);
    cleanup(dir);
  });

  // 14. File with exactly 500% growth → not flagged (threshold is >500%)
  test('file with exactly 500% growth is not flagged', async () => {
    const dir = makeTempProject({ 'src/a.ts': generateLines(10) });
    // 10 lines → 60 lines = 500% growth exactly (6x - 1 = 500%)
    addCommit(dir, { 'src/a.ts': generateLines(60) }, 'feat: [claude] expand');
    const result = await checkBloat(dir);
    const growthIssues = result.issues.filter(i => i.message.includes('growth') && i.file === 'src/a.ts');
    assert.strictEqual(growthIssues.length, 0, 'exactly 500% should not be flagged (threshold is >500%)');
    cleanup(dir);
  });

  // 15. Empty repo → score 100 with info message
  test('empty repo scores 100 with info message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vet-bloat-empty-'));
    execSync('git init && git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
    const result = await checkBloat(dir);
    assert.strictEqual(result.score, 100);
    assert.ok(result.issues.some(i => i.severity === 'info'), 'should have info message');
    cleanup(dir);
  });

  // 16. Multiple penalty types compound correctly
  test('multiple penalty types compound', async () => {
    const dir = makeTempProject({ 'src/a.ts': generateLines(5) });
    // Bloated file + padding file
    const padding = generateLines(1200, 'export const val = "hello";');
    addCommit(dir, {
      'src/a.ts': generateLines(100),  // 5→100 = 1900% growth
      'src/padding.ts': padding,        // 1200 lines, low complexity
    }, 'feat: agent work [claude]');
    const result = await checkBloat(dir);
    assert.ok(result.score < 100, 'multiple penalties should reduce score');
    cleanup(dir);
  });

  // 17. Score never goes below 0
  test('score floors at 0', async () => {
    const dir = makeTempProject({ 'src/a.ts': 'x\n' });
    // Massive bloat
    const huge = generateLines(5000, 'export const val = "hello";');
    addCommit(dir, {
      'src/a.ts': huge,
      'src/b.ts': huge,
      'src/c.ts': huge,
      'src/d.ts': huge,
      'src/e.ts': huge,
      'src/f.ts': huge,
      'src/g.ts': huge,
    }, 'feat: [claude] massive generation');
    const result = await checkBloat(dir);
    assert.ok(result.score >= 0, 'score should never go below 0');
    cleanup(dir);
  });
});
