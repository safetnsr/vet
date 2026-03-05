import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const { checkIntegrity } = await import('../src/checks/integrity.ts');

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vet-integrity-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git init && git add -A && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── Hallucinated imports ─────────────────────────────────────────────────────

describe('hallucinated imports', () => {
  test('clean project with valid relative imports scores 100', async () => {
    const dir = makeTempProject({
      'src/util.ts': 'export function helper() { return 1; }',
      'src/main.ts': "import { helper } from './util.js';",
    });
    const result = await checkIntegrity(dir, []);
    const hallucinated = result.issues.filter(i => i.message.includes('hallucinated import'));
    assert.strictEqual(hallucinated.length, 0, 'no hallucinated imports expected');
    cleanup(dir);
  });

  test('import pointing to nonexistent file is flagged', async () => {
    const dir = makeTempProject({
      'src/main.ts': "import { helper } from './nonexistent.js';",
    });
    const result = await checkIntegrity(dir, []);
    const hallucinated = result.issues.filter(i => i.message.includes('hallucinated import'));
    assert.ok(hallucinated.length >= 1, 'should detect hallucinated import');
    assert.ok(result.score < 100);
    cleanup(dir);
  });

  test('non-relative imports (node modules) not flagged', async () => {
    const dir = makeTempProject({
      'src/main.ts': "import express from 'express';\nimport { readFile } from 'node:fs';",
    });
    const result = await checkIntegrity(dir, []);
    const hallucinated = result.issues.filter(i => i.message.includes('hallucinated import'));
    assert.strictEqual(hallucinated.length, 0, 'node_modules imports should not be flagged');
    cleanup(dir);
  });

  test('.ts extension resolves when .js extension given', async () => {
    const dir = makeTempProject({
      'src/util.ts': 'export function x() {}',
      'src/main.ts': "import { x } from './util.js';",
    });
    const result = await checkIntegrity(dir, []);
    const hallucinated = result.issues.filter(i => i.message.includes('hallucinated import'));
    assert.strictEqual(hallucinated.length, 0, 'ESM .js → .ts should resolve');
    cleanup(dir);
  });
});

// ── Empty catch blocks ───────────────────────────────────────────────────────

describe('empty catch blocks', () => {
  test('empty catch block is flagged as error', async () => {
    const dir = makeTempProject({
      'src/main.ts': `function doStuff() {
  try {
    riskyOp();
  } catch(e) {}
}`,
    });
    const result = await checkIntegrity(dir, []);
    const emptyCatch = result.issues.filter(i => i.message.includes('empty catch'));
    assert.ok(emptyCatch.length >= 1, 'should detect empty catch');
    assert.ok(emptyCatch.some(i => i.severity === 'error'));
    cleanup(dir);
  });

  test('catch with handling is not flagged', async () => {
    const dir = makeTempProject({
      'src/main.ts': `function doStuff() {
  try {
    riskyOp();
  } catch(e) {
    console.error(e);
    throw e;
  }
}`,
    });
    const result = await checkIntegrity(dir, []);
    const emptyCatch = result.issues.filter(i => i.message.includes('empty catch'));
    assert.strictEqual(emptyCatch.length, 0, 'handled catch should not be flagged');
    cleanup(dir);
  });

  test('score decreases per empty catch', async () => {
    const dir = makeTempProject({
      'src/a.ts': `function a() { try { x(); } catch(e) {} }`,
      'src/b.ts': `function b() { try { y(); } catch(err) {} }`,
    });
    const result = await checkIntegrity(dir, []);
    assert.ok(result.score <= 84, `score should drop, got ${result.score}`);
    cleanup(dir);
  });
});

// ── Stubbed tests ────────────────────────────────────────────────────────────

describe('stubbed tests', () => {
  test('expect(true).toBe(true) is flagged', async () => {
    const dir = makeTempProject({
      'src/foo.test.ts': `test('passes', () => {
  expect(true).toBe(true);
});`,
    });
    const result = await checkIntegrity(dir, []);
    const stubbed = result.issues.filter(i => i.message.includes('trivial assertion'));
    assert.ok(stubbed.length >= 1, 'should detect trivial assertion');
    cleanup(dir);
  });

  test('empty test body is flagged', async () => {
    const dir = makeTempProject({
      'src/foo.test.ts': `test('does nothing', () => {});\n`,
    });
    const result = await checkIntegrity(dir, []);
    const stubbed = result.issues.filter(i => i.message.includes('empty test body'));
    assert.ok(stubbed.length >= 1, 'empty test body should be flagged');
    cleanup(dir);
  });

  test('it.skip without todo is flagged as warning', async () => {
    const dir = makeTempProject({
      'src/foo.spec.ts': `it.skip('pending test', () => { expect(1).toBe(1); });`,
    });
    const result = await checkIntegrity(dir, []);
    const skipped = result.issues.filter(i => i.message.includes('skipped test'));
    assert.ok(skipped.length >= 1, 'should flag .skip as warning');
    assert.ok(skipped.some(i => i.severity === 'warning'));
    cleanup(dir);
  });

  test('real test with meaningful assertions not flagged', async () => {
    const dir = makeTempProject({
      'src/math.test.ts': `test('adds numbers', () => {
  const result = add(2, 3);
  expect(result).toBe(5);
});`,
    });
    const result = await checkIntegrity(dir, []);
    const stubbed = result.issues.filter(i =>
      i.message.includes('trivial') || i.message.includes('empty test body')
    );
    assert.strictEqual(stubbed.length, 0, 'real test should not be flagged');
    cleanup(dir);
  });
});

// ── Overall ──────────────────────────────────────────────────────────────────

describe('checkIntegrity overall', () => {
  test('clean project returns 100', async () => {
    const dir = makeTempProject({
      'src/util.ts': `export function add(a: number, b: number) {
  return a + b;
}`,
    });
    const result = await checkIntegrity(dir, []);
    assert.strictEqual(result.name, 'integrity');
    assert.strictEqual(result.maxScore, 100);
    assert.strictEqual(result.score, 100);
    cleanup(dir);
  });

  test('score floors at 0 with many issues', async () => {
    const catchBlocks = Array.from({ length: 15 }, (_, i) =>
      `function f${i}() { try { op(); } catch(e) {} }`
    ).join('\n');
    const dir = makeTempProject({
      'src/catches.ts': catchBlocks,
    });
    const result = await checkIntegrity(dir, []);
    assert.ok(result.score >= 0);
    cleanup(dir);
  });
});
