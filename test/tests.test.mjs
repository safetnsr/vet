import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const { checkTests } = await import('../src/checks/tests.ts');

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vet-tests-test-'));
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

// 1. Clean project with real tests
test('clean project with real tests → score 100', () => {
  const dir = makeTempProject({
    'src/app.test.ts': `
      import { test } from 'node:test';
      import assert from 'node:assert';
      test('adds numbers', () => {
        assert.strictEqual(1 + 1, 2);
      });
    `,
  });
  const result = checkTests(dir, []);
  assert.equal(result.score, 100);
  assert.equal(result.issues.length, 0);
  assert.match(result.summary, /no test anti-patterns/);
  cleanup(dir);
});

// 2. Tautological: expect(true).toBe(true)
test('tautological: expect(true).toBe(true) → error', () => {
  const dir = makeTempProject({
    'foo.test.ts': `
      test('bad', () => {
        expect(true).toBe(true);
      });
    `,
  });
  const result = checkTests(dir, []);
  const errs = result.issues.filter(i => i.severity === 'error' && i.message.includes('tautological'));
  assert.ok(errs.length >= 1);
  assert.ok(result.score < 100);
  cleanup(dir);
});

// 3. Tautological: expect(1).toBe(1)
test('tautological: expect(1).toBe(1) → error', () => {
  const dir = makeTempProject({
    'foo.test.js': `
      test('bad', () => {
        expect(1).toBe(1);
      });
    `,
  });
  const result = checkTests(dir, []);
  const errs = result.issues.filter(i => i.severity === 'error' && i.message.includes('tautological'));
  assert.ok(errs.length >= 1);
  cleanup(dir);
});

// 4. Tautological: assert.strictEqual(x, x) identical args
test('tautological: assert.strictEqual(val, val) → error', () => {
  const dir = makeTempProject({
    'foo.test.ts': `
      test('bad', () => {
        const val = 42;
        assert.strictEqual(val, val);
      });
    `,
  });
  const result = checkTests(dir, []);
  const errs = result.issues.filter(i => i.severity === 'error' && i.message.includes('tautological'));
  assert.ok(errs.length >= 1);
  cleanup(dir);
});

// 5. Empty test body: arrow function
test('empty test body: it(x, () => {}) → error', () => {
  const dir = makeTempProject({
    'foo.test.ts': `it('does nothing', () => {})`,
  });
  const result = checkTests(dir, []);
  const errs = result.issues.filter(i => i.severity === 'error' && i.message.includes('empty test body'));
  assert.ok(errs.length >= 1);
  cleanup(dir);
});

// 6. Empty test body: function keyword
test('empty test body: test(x, function() {}) → error', () => {
  const dir = makeTempProject({
    'foo.test.js': `test('does nothing', function() {})`,
  });
  const result = checkTests(dir, []);
  const errs = result.issues.filter(i => i.severity === 'error' && i.message.includes('empty test body'));
  assert.ok(errs.length >= 1);
  cleanup(dir);
});

// 7. Todo test
test('it.todo → warning', () => {
  const dir = makeTempProject({
    'foo.test.ts': `it.todo('implement later')`,
  });
  const result = checkTests(dir, []);
  const warns = result.issues.filter(i => i.severity === 'warning' && i.message.includes('todo'));
  assert.ok(warns.length >= 1);
  assert.ok(result.score <= 96);
  cleanup(dir);
});

// 8. Skipped test: xit
test('xit → warning', () => {
  const dir = makeTempProject({
    'foo.test.ts': `xit('broken test', () => { expect(1).toBe(2); })`,
  });
  const result = checkTests(dir, []);
  const warns = result.issues.filter(i => i.severity === 'warning' && i.message.includes('skipped'));
  assert.ok(warns.length >= 1);
  cleanup(dir);
});

// 9. Zero-assertion test
test('test with code but no assertions → warning', () => {
  const dir = makeTempProject({
    'foo.test.ts': `
      test('does stuff', () => {
        const x = 1 + 1;
        console.log(x);
      });
    `,
  });
  const result = checkTests(dir, []);
  const warns = result.issues.filter(i => i.severity === 'warning' && i.message.includes('no assertions'));
  assert.ok(warns.length >= 1);
  cleanup(dir);
});

// 10. Mock-only test
test('mock-only test → info', () => {
  const dir = makeTempProject({
    'foo.test.ts': `
      test('only mocks', () => {
        const mockFn = jest.fn();
        mockFn();
        expect(mockFn).mock.calls.length;
        expect(mockFn.mock.results[0]).toBe(undefined);
      });
    `,
  });
  const result = checkTests(dir, []);
  const infos = result.issues.filter(i => i.severity === 'info' && i.message.includes('mock'));
  assert.ok(infos.length >= 1);
  cleanup(dir);
});

// 11. Duplicate describe blocks
test('duplicate describe blocks → info', () => {
  const dir = makeTempProject({
    'foo.test.ts': `
      describe('utils', () => { test('a', () => { expect(1).toBe(1); }); });
      describe('utils', () => { test('b', () => { expect(2).toBe(2); }); });
    `,
  });
  const result = checkTests(dir, []);
  const infos = result.issues.filter(i => i.severity === 'info' && i.message.includes('duplicate describe'));
  assert.ok(infos.length >= 1);
  cleanup(dir);
});

// 12. Multiple anti-patterns in one file
test('multiple anti-patterns → all detected, score reduced', () => {
  const dir = makeTempProject({
    'foo.test.ts': `
      it('empty', () => {})
      expect(true).toBe(true);
      it.todo('later')
      test('no assert', () => { const x = 1; })
    `,
  });
  const result = checkTests(dir, []);
  assert.ok(result.issues.length >= 3);
  assert.ok(result.score < 80);
  cleanup(dir);
});

// 13. Non-test files ignored
test('non-test files with test-like code → ignored', () => {
  const dir = makeTempProject({
    'src/helper.ts': `
      // this is not a test file
      expect(true).toBe(true);
      it('fake', () => {})
    `,
  });
  const result = checkTests(dir, []);
  assert.equal(result.score, 100);
  assert.equal(result.issues.length, 0);
  cleanup(dir);
});

// 14. Mixed project: some good, some bad
test('mixed project → partial score', () => {
  const dir = makeTempProject({
    'good.test.ts': `
      test('works', () => {
        expect(add(1, 2)).toBe(3);
      });
    `,
    'bad.test.ts': `
      it('empty', () => {})
      it.todo('later')
    `,
  });
  const result = checkTests(dir, []);
  assert.ok(result.issues.length >= 2);
  assert.ok(result.score > 0);
  assert.ok(result.score < 100);
  cleanup(dir);
});

// 15. No test files → score 100
test('no test files → score 100', () => {
  const dir = makeTempProject({
    'src/app.ts': `export const x = 1;`,
  });
  const result = checkTests(dir, []);
  assert.equal(result.score, 100);
  assert.equal(result.issues.length, 0);
  cleanup(dir);
});

// 16. Nested test directories detected
test('nested __tests__ directory detected', () => {
  const dir = makeTempProject({
    'src/__tests__/deep/helper.ts': `
      it('empty nested', () => {})
    `,
  });
  const result = checkTests(dir, []);
  const errs = result.issues.filter(i => i.severity === 'error');
  assert.ok(errs.length >= 1);
  cleanup(dir);
});

// 17. Result shape
test('result has correct name and shape', () => {
  const dir = makeTempProject({});
  const result = checkTests(dir, []);
  assert.equal(result.name, 'tests');
  assert.equal(result.maxScore, 100);
  assert.ok(typeof result.summary === 'string');
  assert.ok(Array.isArray(result.issues));
  cleanup(dir);
});
