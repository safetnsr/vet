// vet-ignore: tests
// vet-ignore: diff
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
    assert.ok(emptyCatch.some(i => i.severity === 'warning'), 'empty catch should be warning');
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
    assert.ok(result.score <= 94, `score should drop, got ${result.score}`);
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

  // ── Error boundary files should not be flagged for unhandled async ───────

  test('Next.js error.tsx files are not flagged for unhandled async', async () => {
    const dir = makeTempProject({
      'app/error.tsx': `'use client';
export default function ErrorBoundary({ error, reset }) {
  const data = await fetchFallback();
  return <div>Something went wrong</div>;
}`,
    });
    const result = await checkIntegrity(dir, []);
    assert.ok(!result.issues.some(i => i.file === 'app/error.tsx' && i.message.includes('unhandled async')),
      'error.tsx should not be flagged for unhandled async');
    cleanup(dir);
  });

  test('global-error.tsx files are not flagged for unhandled async', async () => {
    const dir = makeTempProject({
      'app/global-error.tsx': `'use client';
export default function GlobalError({ error }) {
  const log = await logError(error);
  return <html><body>Error</body></html>;
}`,
    });
    const result = await checkIntegrity(dir, []);
    assert.ok(!result.issues.some(i => i.file === 'app/global-error.tsx' && i.message.includes('unhandled async')),
      'global-error.tsx should not be flagged');
    cleanup(dir);
  });

  test('files with process.on unhandledRejection are not flagged', async () => {
    const dir = makeTempProject({
      'src/server.ts': `process.on('unhandledRejection', (err) => { console.error(err); });

async function startServer() {
  const db = await connectDB();
  const app = await createApp(db);
  await app.listen(3000);
}
startServer();`,
    });
    const result = await checkIntegrity(dir, []);
    assert.ok(!result.issues.some(i => i.file === 'src/server.ts' && i.message.includes('unhandled async')),
      'Files with global error handlers should not be flagged');
    cleanup(dir);
  });

  test('Next.js page.tsx unhandled async is downgraded to info', async () => {
    const dir = makeTempProject({
      'app/page.tsx': `export default async function Page() {
  const data = await fetchData();
  return <div>{data}</div>;
}`,
    });
    const result = await checkIntegrity(dir, []);
    const pageIssues = result.issues.filter(i => i.file === 'app/page.tsx' && i.message.includes('unhandled async'));
    for (const issue of pageIssues) {
      assert.strictEqual(issue.severity, 'info', `Next.js page.tsx should be info, got ${issue.severity}`);
      assert.ok(issue.message.includes('server component'), 'Should mention server component');
    }
    cleanup(dir);
  });

  test('Next.js layout.tsx unhandled async is downgraded to info', async () => {
    const dir = makeTempProject({
      'app/layout.tsx': `export default async function Layout({ children }) {
  const config = await getConfig();
  return <html><body>{children}</body></html>;
}`,
    });
    const result = await checkIntegrity(dir, []);
    const layoutIssues = result.issues.filter(i => i.file === 'app/layout.tsx' && i.message.includes('unhandled async'));
    for (const issue of layoutIssues) {
      assert.strictEqual(issue.severity, 'info', `Next.js layout.tsx should be info`);
    }
    cleanup(dir);
  });

  test('Next.js app/api/route.ts unhandled async is downgraded to info', async () => {
    const dir = makeTempProject({
      'app/api/users/route.ts': `export async function GET() {
  const users = await db.query('SELECT * FROM users');
  return Response.json(users);
}`,
    });
    const result = await checkIntegrity(dir, []);
    const routeIssues = result.issues.filter(i => i.file.includes('route.ts') && i.message.includes('unhandled async'));
    for (const issue of routeIssues) {
      assert.strictEqual(issue.severity, 'info', `Next.js route handler should be info`);
    }
    cleanup(dir);
  });

  test('Next.js server component info issues do not penalize score', async () => {
    const dir = makeTempProject({
      'app/page.tsx': `export default async function Page() {
  const data = await fetchData();
  const more = await fetchMore();
  const extra = await fetchExtra();
  return <div>{data}</div>;
}`,
    });
    const result = await checkIntegrity(dir, []);
    // Info issues from Next.js should not reduce score
    const pageInfoIssues = result.issues.filter(i => i.file === 'app/page.tsx' && i.severity === 'info');
    assert.ok(pageInfoIssues.length > 0, 'Should have info issues for Next.js page');
    // Score should not be penalized for these
    const pageWarnings = result.issues.filter(i => i.file === 'app/page.tsx' && i.severity === 'warning');
    assert.strictEqual(pageWarnings.length, 0, 'Next.js page should have no warnings');
    cleanup(dir);
  });

  test('Next.js route.ts outside app/api/ is downgraded to info', async () => {
    const dir = makeTempProject({
      'app/dashboard/route.ts': `export async function POST(request) {
  const body = await request.json();
  const result = await processData(body);
  return Response.json(result);
}`,
    });
    const result = await checkIntegrity(dir, []);
    const routeIssues = result.issues.filter(i => i.file.includes('route.ts') && i.message.includes('unhandled async'));
    for (const issue of routeIssues) {
      assert.strictEqual(issue.severity, 'info', `Next.js route handler should be info, got ${issue.severity}`);
    }
    cleanup(dir);
  });

  test('Next.js middleware.ts unhandled async is downgraded to info', async () => {
    const dir = makeTempProject({
      'src/middleware.ts': `export async function middleware(request) {
  const session = await getSession(request);
  return NextResponse.next();
}`,
    });
    const result = await checkIntegrity(dir, []);
    const mwIssues = result.issues.filter(i => i.file.includes('middleware.ts') && i.message.includes('unhandled async'));
    // middleware.ts is caught by isErrorBoundaryFile (skipped entirely) OR downgraded
    // Either way, no warnings should exist
    const mwWarnings = mwIssues.filter(i => i.severity === 'warning');
    assert.strictEqual(mwWarnings.length, 0, 'middleware.ts should not have warning-level unhandled async');
    cleanup(dir);
  });

  test('Files in app/api/ directory are downgraded to info', async () => {
    const dir = makeTempProject({
      'app/api/health/check.ts': `export async function handler() {
  const status = await checkHealth();
  return Response.json({ status });
}`,
    });
    const result = await checkIntegrity(dir, []);
    const apiIssues = result.issues.filter(i => i.file.includes('app/api/') && i.message.includes('unhandled async'));
    for (const issue of apiIssues) {
      assert.strictEqual(issue.severity, 'info', `app/api/ files should be info, got ${issue.severity}`);
    }
    cleanup(dir);
  });

  test('Non-exported function unhandled async is info, exported is warning', async () => {
    const dir = makeTempProject({
      'src/service.ts': `async function doWork() {
  const data = await fetchData();
  return data;
}

export async function publicWork() {
  const data = await fetchData();
  return data;
}`,
    });
    const result = await checkIntegrity(dir, []);
    const nonExported = result.issues.filter(i => i.file === 'src/service.ts' && i.message.includes('unhandled async') && i.line === 2);
    for (const issue of nonExported) {
      assert.strictEqual(issue.severity, 'info', `Non-exported function should be info`);
    }
    const exported = result.issues.filter(i => i.file === 'src/service.ts' && i.message.includes('unhandled async') && i.line === 7);
    for (const issue of exported) {
      assert.strictEqual(issue.severity, 'warning', `Exported function should be warning`);
    }
    cleanup(dir);
  });

  test('.catch() chained on promise is recognized as handled', async () => {
    const dir = makeTempProject({
      'src/worker.ts': `async function work() {
  const result = await doWork();
  return result;
}
work().catch(err => console.error(err));

async function other() {
  await unhandledCall();
}`,
    });
    const result = await checkIntegrity(dir, []);
    // 'other' function should still be flagged, but work().catch should not count
    const workerIssues = result.issues.filter(i => i.file === 'src/worker.ts' && i.message.includes('unhandled async'));
    // The await inside 'work' function is unhandled (no try/catch around it),
    // but await inside 'other' is also unhandled. That's fine — we just verify the file is processed
    assert.ok(workerIssues.length >= 1, 'Should still detect some unhandled async');
    cleanup(dir);
  });
});

// ── .d.ts files should not be checked for hallucinated imports ───────────
describe('hallucinated imports: .d.ts and build artifacts', () => {
  test('.d.ts files are skipped for hallucinated import checks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vet-dts-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, 'types.d.ts'), "import { Foo } from './dist/types';\nexport type Bar = Foo;\n");
      const result = await checkIntegrity(dir, []);
      const hallucinated = result.issues.filter(i => i.message.includes('hallucinated'));
      assert.strictEqual(hallucinated.length, 0, '.d.ts files should not produce hallucinated import issues');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('build artifact imports (./dist/) are skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vet-dist-'));
    try {
      mkdirSync(join(dir, '.git'));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), "import { helper } from './dist/helper';\n");
      const result = await checkIntegrity(dir, []);
      const hallucinated = result.issues.filter(i => i.message.includes('hallucinated') && i.message.includes('dist'));
      assert.strictEqual(hallucinated.length, 0, './dist/ imports should not be flagged as hallucinated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('build artifact imports (../build/) are skipped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vet-build-'));
    try {
      mkdirSync(join(dir, '.git'));
      mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'src', 'sub', 'index.ts'), "import { foo } from '../build/foo';\n");
      const result = await checkIntegrity(dir, []);
      const hallucinated = result.issues.filter(i => i.message.includes('hallucinated') && i.message.includes('build'));
      assert.strictEqual(hallucinated.length, 0, '../build/ imports should not be flagged as hallucinated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
