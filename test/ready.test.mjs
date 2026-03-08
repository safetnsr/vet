import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { checkReady } = await import('../src/checks/ready.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-ready-test-'));
}

describe('checkReady', () => {
  test('Python monorepo with subdir pyproject.toml: no "no package manifest" error', async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# My Python Monorepo');
      mkdirSync(join(dir, 'lib1'), { recursive: true });
      writeFileSync(join(dir, 'lib1/pyproject.toml'), '[project]\nname = "lib1"');
      mkdirSync(join(dir, 'lib1/src'), { recursive: true });
      // Add enough Python files to trigger code check
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(dir, `lib1/src/mod${i}.py`), `def func${i}():\n  pass\n`);
      }
      mkdirSync(join(dir, 'lib1/tests'), { recursive: true });
      writeFileSync(join(dir, 'lib1/tests/test_mod.py'), 'def test_something():\n  assert True\n');
      const result = await checkReady(dir, []);
      assert.ok(!result.issues.some(i => i.message.includes('no package manifest')),
        'Python monorepo should not flag "no package manifest"');
      assert.ok(!result.issues.some(i => i.message.includes('no tests')),
        'Should detect test_*.py in subdirectories');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('Python project with root pyproject.toml: no manifest error', async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Python app');
      writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "myapp"');
      mkdirSync(join(dir, 'src'), { recursive: true });
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(dir, `src/mod${i}.py`), `x = ${i}\n`);
      }
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writeFileSync(join(dir, 'tests/test_main.py'), 'def test_it(): pass\n');
      const result = await checkReady(dir, []);
      assert.ok(!result.issues.some(i => i.message.includes('no package manifest')),
        'Python project with pyproject.toml should not flag manifest');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('monorepo summary mentions monorepo detected', async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# Monorepo');
      mkdirSync(join(dir, 'pkg-a'), { recursive: true });
      writeFileSync(join(dir, 'pkg-a/pyproject.toml'), '[project]\nname = "a"');
      mkdirSync(join(dir, 'pkg-b'), { recursive: true });
      writeFileSync(join(dir, 'pkg-b/pyproject.toml'), '[project]\nname = "b"');
      const result = await checkReady(dir, []);
      assert.ok(result.summary.includes('monorepo detected'),
        `Summary should mention monorepo, got: ${result.summary}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('detects *_test.py pattern in subdirectories', async () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'README.md'), '# App');
      writeFileSync(join(dir, 'requirements.txt'), 'flask\n');
      mkdirSync(join(dir, 'app'), { recursive: true });
      for (let i = 0; i < 6; i++) {
        writeFileSync(join(dir, `app/mod${i}.py`), `x = ${i}\n`);
      }
      mkdirSync(join(dir, 'app/testing'), { recursive: true });
      writeFileSync(join(dir, 'app/testing/utils_test.py'), 'def test_util(): pass\n');
      const result = await checkReady(dir, []);
      assert.ok(!result.issues.some(i => i.message.includes('no tests')),
        'Should detect *_test.py files in subdirs');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
