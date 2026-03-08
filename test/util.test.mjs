import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { walkFiles } = await import('../src/util.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-util-'));
}

// ── walkFiles: maxFiles limits output ────────────────────────────────────
test('walkFiles: maxFiles limits the number of returned files', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(dir, 'src', `file${i}.ts`), `// file ${i}`);
    }
    const all = walkFiles(dir);
    assert.equal(all.length, 20);
    const limited = walkFiles(dir, [], 5);
    assert.equal(limited.length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── walkFiles: maxFiles prioritizes src/ over examples/ ──────────────────
test('walkFiles: maxFiles prioritizes src/ over examples/', () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'examples'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, 'src', `s${i}.ts`), `// src ${i}`);
      writeFileSync(join(dir, 'examples', `e${i}.ts`), `// example ${i}`);
    }
    const limited = walkFiles(dir, [], 7);
    assert.equal(limited.length, 7);
    // After priority sort, src/ files should appear before examples/ files
    const firstExample = limited.findIndex(f => f.startsWith('examples/'));
    const lastSrc = limited.reduce((max, f, i) => f.startsWith('src/') ? i : max, -1);
    if (firstExample !== -1 && lastSrc !== -1) {
      assert.ok(lastSrc < firstExample, 'src/ files should be sorted before examples/ files');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── walkFiles: no maxFiles returns all ───────────────────────────────────
test('walkFiles: without maxFiles returns all files', () => {
  const dir = makeTmpDir();
  try {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `f${i}.js`), '');
    }
    const all = walkFiles(dir);
    assert.equal(all.length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
