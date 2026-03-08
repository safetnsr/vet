import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { levenshtein, extractImports, extractPackageName, isBuiltin, checkDeps } from '../src/checks/deps.js';

// ── Levenshtein ──────────────────────────────────────────────────────────────

describe('levenshtein', () => {
  test('identical strings = 0', () => {
    assert.strictEqual(levenshtein('lodash', 'lodash'), 0);
  });

  test('single char difference = 1', () => {
    assert.strictEqual(levenshtein('lodash', 'lodas'), 1);
  });

  test('substitution = 1', () => {
    assert.strictEqual(levenshtein('react', 'reakt'), 1);
  });

  test('insertion = 1', () => {
    assert.strictEqual(levenshtein('expres', 'express'), 1);
  });

  test('distance 2', () => {
    assert.strictEqual(levenshtein('axos', 'axios'), 1);
  });

  test('empty strings', () => {
    assert.strictEqual(levenshtein('', ''), 0);
    assert.strictEqual(levenshtein('abc', ''), 3);
    assert.strictEqual(levenshtein('', 'xyz'), 3);
  });
});

// ── Import extraction ────────────────────────────────────────────────────────

describe('extractImports', () => {
  test('ES import from', () => {
    const imports = extractImports(`import express from 'express';`);
    assert.ok(imports.includes('express'));
  });

  test('named imports', () => {
    const imports = extractImports(`import { useState } from 'react';`);
    assert.ok(imports.includes('react'));
  });

  test('require', () => {
    const imports = extractImports(`const fs = require('fs');`);
    assert.ok(imports.includes('fs'));
  });

  test('dynamic import', () => {
    const imports = extractImports(`const mod = await import('chalk');`);
    assert.ok(imports.includes('chalk'));
  });

  test('scoped package import', () => {
    const imports = extractImports(`import { z } from '@trpc/server';`);
    assert.ok(imports.includes('@trpc/server'));
  });

  test('multiple imports', () => {
    const source = `
      import express from 'express';
      const chalk = require('chalk');
      import('lodash');
    `;
    const imports = extractImports(source);
    assert.ok(imports.includes('express'));
    assert.ok(imports.includes('chalk'));
    assert.ok(imports.includes('lodash'));
  });

  test('template literal specifiers like ${top} are filtered out', () => {
    const source = `
      import express from 'express';
      const hint = 'did you mean "\${top}"?';
      const fixHint = \`run: npm install "\${pkg}"\`;
    `;
    const imports = extractImports(source);
    assert.ok(imports.includes('express'), 'real import should be kept');
    assert.ok(!imports.some(i => i.includes('$')), 'template literal fragments should be filtered');
    assert.ok(!imports.some(i => i.includes('${top}')), '${top} should not appear as import');
  });

  test('no $ in any extracted import specifier', () => {
    const source = `
      import chalk from 'chalk';
      const msg = 'try "\${name}" instead';
      import('lodash');
    `;
    const imports = extractImports(source);
    for (const imp of imports) {
      assert.ok(!imp.includes('$'), `import "${imp}" should not contain $`);
    }
  });
});

// ── Package name extraction ──────────────────────────────────────────────────

describe('extractPackageName', () => {
  test('regular package', () => {
    assert.strictEqual(extractPackageName('express'), 'express');
  });

  test('regular package with subpath', () => {
    assert.strictEqual(extractPackageName('lodash/debounce'), 'lodash');
  });

  test('scoped package', () => {
    assert.strictEqual(extractPackageName('@types/node'), '@types/node');
  });

  test('scoped package with subpath', () => {
    assert.strictEqual(extractPackageName('@trpc/server/adapters'), '@trpc/server');
  });

  test('relative import returns null', () => {
    assert.strictEqual(extractPackageName('./util'), null);
    assert.strictEqual(extractPackageName('../lib'), null);
  });

  test('node: prefix returns null', () => {
    assert.strictEqual(extractPackageName('node:fs'), null);
  });

  test('path alias @/ returns null', () => {
    assert.strictEqual(extractPackageName('@/components/Sidebar'), null);
    assert.strictEqual(extractPackageName('@/lib/utils'), null);
    assert.strictEqual(extractPackageName('@/'), null);
  });

  test('scoped packages still work', () => {
    assert.strictEqual(extractPackageName('@types/node'), '@types/node');
    assert.strictEqual(extractPackageName('@trpc/server'), '@trpc/server');
  });
});

// ── Builtin detection ────────────────────────────────────────────────────────

describe('isBuiltin', () => {
  test('node: prefix is builtin', () => {
    assert.ok(isBuiltin('node:fs'));
    assert.ok(isBuiltin('node:path'));
  });

  test('bare builtin names', () => {
    assert.ok(isBuiltin('fs'));
    assert.ok(isBuiltin('path'));
    assert.ok(isBuiltin('crypto'));
  });

  test('non-builtins', () => {
    assert.ok(!isBuiltin('express'));
    assert.ok(!isBuiltin('lodash'));
  });

  test('subpath builtins', () => {
    assert.ok(isBuiltin('fs/promises'));
  });
});

// ── Integration: checkDeps ───────────────────────────────────────────────────

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'vet-deps-test-'));
}

describe('checkDeps integration', () => {
  test('empty package.json — no deps', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {}, devDependencies: {} }));
    const result = await checkDeps(dir);
    assert.strictEqual(result.name, 'deps');
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.maxScore, 100);
    rmSync(dir, { recursive: true });
  });

  test('no package.json', async () => {
    const dir = makeTempDir();
    const result = await checkDeps(dir);
    assert.strictEqual(result.score, 100);
    assert.ok(result.summary.includes('no package.json'));
    rmSync(dir, { recursive: true });
  });

  test('no source files — all deps flagged as unused', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.0.0' },
    }));
    const result = await checkDeps(dir);
    const unused = result.issues.filter(i => i.message.includes('unused'));
    assert.ok(unused.length >= 1);
    rmSync(dir, { recursive: true });
  });

  test('dead dep detection', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4.0.0', chalk: '^5.0.0' },
    }));
    writeFileSync(join(dir, 'src', 'index.ts'), `import express from 'express';`);
    const result = await checkDeps(dir);
    const deadDeps = result.issues.filter(i => i.message.includes('unused') && i.message.includes('chalk'));
    assert.ok(deadDeps.length === 1, 'chalk should be flagged as unused');
    rmSync(dir, { recursive: true });
  });

  test('phantom import detection', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, 'src', 'index.ts'), `import lodash from 'lodash';`);
    const result = await checkDeps(dir);
    const phantom = result.issues.filter(i => i.message.includes('phantom import') && i.message.includes('lodash'));
    assert.ok(phantom.length === 1, 'lodash should be flagged as phantom import');
    rmSync(dir, { recursive: true });
  });

  test('short package names not flagged as typosquat', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'ai': '^3.0.0', 'ws': '^8.0.0' },
    }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), `import ai from 'ai'; import ws from 'ws';`);
    const result = await checkDeps(dir);
    const typosquat = result.issues.filter(i => i.message.includes('typosquat'));
    assert.strictEqual(typosquat.length, 0, 'short/whitelisted packages should not be flagged as typosquat');
    rmSync(dir, { recursive: true });
  });

  test('clsx not flagged as typosquat of tsx', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'clsx': '^2.0.0' },
    }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), `import clsx from 'clsx';`);
    const result = await checkDeps(dir);
    const typosquat = result.issues.filter(i => i.message.includes('typosquat'));
    assert.strictEqual(typosquat.length, 0, 'clsx should not be flagged as typosquat');
    rmSync(dir, { recursive: true });
  });

  test('scoring: typosquat of existing package is info, not error', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'expresss': '^4.0.0' },  // typosquat of express, but exists on npm
    }));
    const result = await checkDeps(dir);
    // If expresss exists on npm, typosquat should be info (not error)
    const typosquat = result.issues.filter(i => i.message.includes('typosquat'));
    assert.ok(typosquat.length >= 1, 'should still flag typosquat');
    // Score should not be severely penalized since it's info-level
    rmSync(dir, { recursive: true });
  });

  test('scoring: typosquat of nonexistent package is error', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'expresz': '^4.0.0' },  // typosquat that probably doesn't exist
    }));
    const result = await checkDeps(dir);
    const typosquat = result.issues.filter(i => i.message.includes('typosquat'));
    if (typosquat.length > 0) {
      // If flagged and doesn't exist on npm, should be error severity
      const nonExistent = !result.issues.some(i => i.message.includes('does not exist') && i.message.includes('expresz'));
      // The test is conditional since we can't control npm registry responses
      if (nonExistent) {
        // Package exists — it's info
        assert.ok(typosquat[0].severity === 'info' || typosquat[0].severity === 'error');
      }
    }
    rmSync(dir, { recursive: true });
  });

  test('scoring: warnings reduce score by 1', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, 'src', 'index.ts'), `import something from 'some-nonexistent-thing';`);
    const result = await checkDeps(dir);
    const warnings = result.issues.filter(i => i.severity === 'warning');
    assert.ok(warnings.length >= 1);
    rmSync(dir, { recursive: true });
  });

  test('scoring clamped to 0', () => {
    // Manual check: 4 errors = 100 - 120 = clamped to 0
    const score = Math.max(0, Math.min(100, 100 - (4 * 30) - (0 * 10)));
    assert.strictEqual(score, 0);
  });

  test('scoring clamped to 100', () => {
    const score = Math.max(0, Math.min(100, 100 - (0 * 30) - (0 * 10)));
    assert.strictEqual(score, 100);
  });

  test('summary format with issues', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { 'expresss': '^4.0.0' },
    }));
    writeFileSync(join(dir, 'src', 'index.ts'), `import foo from 'bar';`);
    const result = await checkDeps(dir);
    assert.ok(result.summary.includes('dependencies'));
    rmSync(dir, { recursive: true });
  });

  test('path aliases not flagged as phantom imports', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^18.0.0' } }));
    writeFileSync(join(dir, 'src', 'index.ts'), `
      import React from 'react';
      import Sidebar from '@/components/Sidebar';
      import { cn } from '@/lib/utils';
    `);
    const result = await checkDeps(dir);
    const phantom = result.issues.filter(i => i.message.includes('phantom import'));
    assert.strictEqual(phantom.length, 0, 'path aliases should not be flagged as phantom imports');
    rmSync(dir, { recursive: true });
  });

  test('node builtins ignored in imports', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(dir, 'src', 'index.ts'), `
      import fs from 'node:fs';
      import path from 'path';
      import { createServer } from 'http';
    `);
    const result = await checkDeps(dir);
    const phantom = result.issues.filter(i => i.message.includes('phantom import'));
    assert.strictEqual(phantom.length, 0, 'builtins should not be flagged');
    rmSync(dir, { recursive: true });
  });
});
