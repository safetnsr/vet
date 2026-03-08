import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const BENCH_DIR = '/tmp/vet-perf-bench';
const DIRS = ['src', 'lib', 'utils', 'components', 'pages'];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateFunctionBody(lines) {
  const stmts = [
    'const x = Math.random();',
    'let result = 0;',
    'for (let i = 0; i < 10; i++) { result += i; }',
    'if (result > 5) { result = result * 2; }',
    'const arr = [1, 2, 3].map(n => n * 2);',
    'try { JSON.parse("{}"); } catch (e) { console.error(e); }',
    'const obj = { key: "value", num: 42 };',
    'return result;',
  ];
  const body = [];
  for (let i = 0; i < lines; i++) {
    body.push('  ' + stmts[i % stmts.length]);
  }
  return body.join('\n');
}

function generateFile(index, dir) {
  const numFuncs = randInt(2, 5);
  const funcs = [];
  for (let f = 0; f < numFuncs; f++) {
    const lines = randInt(10, 200);
    const name = `func_${dir}_${index}_${f}`;
    funcs.push(`export function ${name}(input: string): number {\n${generateFunctionBody(lines)}\n}`);
  }
  return funcs.join('\n\n');
}

function generateDuplicate(index, original) {
  // Exact duplicate with different name
  return original.replace(/func_\w+/g, `dupFunc_${index}`);
}

function generateNearDuplicate(index, original) {
  // Change a few characters to make it ~93% similar
  let modified = original.replace(/func_\w+/g, `nearDup_${index}`);
  modified = modified.replace(/Math\.random\(\)/g, 'Math.ceil(Math.random())');
  modified = modified.replace(/result \+= i/g, 'result += i + 1');
  return modified;
}

describe('Performance benchmark', { timeout: 60_000 }, () => {
  before(() => {
    // Clean up any previous run
    if (existsSync(BENCH_DIR)) rmSync(BENCH_DIR, { recursive: true });
    mkdirSync(BENCH_DIR, { recursive: true });

    // Generate directory structure
    for (const dir of DIRS) {
      mkdirSync(join(BENCH_DIR, dir), { recursive: true });
      for (let sub = 0; sub < 3; sub++) {
        mkdirSync(join(BENCH_DIR, dir, `sub${sub}`), { recursive: true });
      }
    }

    // Generate 3000 .ts files
    let fileCount = 0;
    const originals = []; // Store some for duplication
    for (const dir of DIRS) {
      const filesPerDir = 600;
      for (let i = 0; i < filesPerDir; i++) {
        const subDir = `sub${i % 3}`;
        const content = generateFile(i, dir);
        const filePath = join(BENCH_DIR, dir, subDir, `file_${i}.ts`);
        writeFileSync(filePath, content);
        fileCount++;
        if (originals.length < 70) originals.push(content);
      }
    }

    // Generate ~20 exact duplicates
    for (let i = 0; i < 20; i++) {
      const dup = generateDuplicate(i, originals[i % originals.length]);
      writeFileSync(join(BENCH_DIR, 'src', `exact_dup_${i}.ts`), dup);
    }

    // Generate ~50 near-duplicates
    for (let i = 0; i < 50; i++) {
      const nearDup = generateNearDuplicate(i, originals[i % originals.length]);
      writeFileSync(join(BENCH_DIR, 'lib', `near_dup_${i}.ts`), nearDup);
    }

    // Unhandled async files
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(BENCH_DIR, 'utils', `async_${i}.ts`), `
export async function fetchData_${i}() {
  const res = await fetch('https://api.example.com/data');
  const data = await res.json();
  return data;
}
`);
    }

    // Barrel index files
    for (const dir of DIRS) {
      const exports = Array.from({ length: 20 }, (_, i) => `export { func_${dir}_${i}_0 } from './sub0/file_${i}.js';`);
      writeFileSync(join(BENCH_DIR, dir, 'index.ts'), exports.join('\n'));
    }

    // .d.ts files with ./dist/ imports
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(BENCH_DIR, 'src', `types_${i}.d.ts`), `
import { SomeType } from './dist/types';
export declare function helper_${i}(x: SomeType): void;
`);
    }

    // package.json with 15 deps
    const deps = {};
    const depNames = ['react', 'next', 'typescript', 'zod', 'prisma', '@prisma/client', 'tailwindcss', 'postcss', 'autoprefixer', 'eslint', 'prettier', 'lodash', 'date-fns', 'axios', 'dotenv'];
    for (const d of depNames) deps[d] = '^1.0.0';
    writeFileSync(join(BENCH_DIR, 'package.json'), JSON.stringify({
      name: 'perf-bench',
      version: '1.0.0',
      dependencies: deps,
    }, null, 2));

    // CLAUDE.md referencing some packages
    writeFileSync(join(BENCH_DIR, 'CLAUDE.md'), `
# Project

Uses react, next, prisma, zod for the stack.
Run \`npm run dev\` to start.
`);

    // Initialize git repo
    execSync('git init && git add -A && git commit -m "init"', { cwd: BENCH_DIR, stdio: 'pipe' });

    console.log(`  Generated ${fileCount + 85} files in ${BENCH_DIR}`);
  });

  after(() => {
    if (existsSync(BENCH_DIR)) rmSync(BENCH_DIR, { recursive: true });
  });

  it('debt check completes in < 10 seconds', async () => {
    const { checkDebt } = await import('../dist/checks/debt.js');
    const start = Date.now();
    const result = await checkDebt(BENCH_DIR, []);
    const elapsed = Date.now() - start;
    console.log(`    debt: ${elapsed}ms (${result.issues.length} issues)`);
    assert.ok(elapsed < 10_000, `debt took ${elapsed}ms, expected < 10000ms`);
  });

  it('integrity check completes in < 5 seconds', async () => {
    const { checkIntegrity } = await import('../dist/checks/integrity.js');
    const start = Date.now();
    const result = await checkIntegrity(BENCH_DIR, []);
    const elapsed = Date.now() - start;
    console.log(`    integrity: ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `integrity took ${elapsed}ms, expected < 5000ms`);
  });

  it('deps check completes in < 5 seconds', async () => {
    const { checkDeps } = await import('../dist/checks/deps.js');
    const start = Date.now();
    const result = await checkDeps(BENCH_DIR);
    const elapsed = Date.now() - start;
    console.log(`    deps: ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `deps took ${elapsed}ms, expected < 5000ms`);
  });

  it('ready check completes in < 5 seconds', async () => {
    const { checkReady } = await import('../dist/checks/ready.js');
    const start = Date.now();
    const result = await checkReady(BENCH_DIR, []);
    const elapsed = Date.now() - start;
    console.log(`    ready: ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `ready took ${elapsed}ms, expected < 5000ms`);
  });

  it('verify check completes in < 5 seconds', async () => {
    const { checkVerify } = await import('../dist/checks/verify.js');
    const start = Date.now();
    const result = await checkVerify(BENCH_DIR);
    const elapsed = Date.now() - start;
    console.log(`    verify: ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `verify took ${elapsed}ms, expected < 5000ms`);
  });

  it('tests check completes in < 5 seconds', async () => {
    const { checkTests } = await import('../dist/checks/tests.js');
    const start = Date.now();
    const result = await checkTests(BENCH_DIR, []);
    const elapsed = Date.now() - start;
    console.log(`    tests: ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `tests took ${elapsed}ms, expected < 5000ms`);
  });

  it('full CLI completes in < 15 seconds', async () => {
    const start = Date.now();
    const output = execSync(`node ${join(process.cwd(), 'dist/cli.js')} --json`, {
      cwd: BENCH_DIR,
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    const elapsed = Date.now() - start;
    const result = JSON.parse(output);
    console.log(`    full CLI: ${elapsed}ms (score: ${result.score}, grade: ${result.grade})`);
    assert.ok(elapsed < 15_000, `full CLI took ${elapsed}ms, expected < 15000ms`);
    assert.ok(result.score >= 0 && result.score <= 100, 'score should be 0-100');
  });
});
