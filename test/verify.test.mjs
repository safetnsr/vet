import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const { checkVerify } = await import('../src/checks/verify.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-verify-'));
}

function gitInit(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "tester"', { cwd: dir, stdio: 'pipe' });
}

function gitCommit(dir, msg) {
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}" --allow-empty`, { cwd: dir, stdio: 'pipe' });
}

// ── 1. Not a git repo → score 100 gracefully ──────────────────────────────
test('checkVerify: non-git dir returns score 100', async () => {
  const dir = makeTmpDir();
  try {
    const result = checkVerify(dir);
    assert.equal(result.name, 'verify');
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 2. Git repo with no commits → score 100 ───────────────────────────────
test('checkVerify: git repo with no commits returns score 100', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    const result = checkVerify(dir);
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 3. New file added and exists → score 100 ──────────────────────────────
test('checkVerify: changed file exists with good content → score 100', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    // Create initial commit
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    // Add a file with >10 lines
    const content = Array(15).fill(0).map((_, i) => `const line${i} = ${i};`).join('\n');
    writeFileSync(join(dir, 'src.js'), content);
    gitCommit(dir, 'add src.js');
    const result = checkVerify(dir);
    assert.equal(result.score, 100, `Expected 100 but got ${result.score}: ${JSON.stringify(result.issues)}`);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 4. Claim in message for missing file → error issue ────────────────────
test('checkVerify: explicit claim for missing file → error', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    // Commit that claims to create a file but doesn't actually create it
    gitCommit(dir, 'created missing-module.ts with auth logic');
    const result = checkVerify(dir);
    assert.ok(result.score < 100, `score should be < 100, got ${result.score}`);
    assert.ok(result.issues.some(i => i.severity === 'error' && i.message.includes('missing-module.ts')),
      `Expected error about missing-module.ts, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 5. Test file with assertions → score 100 ──────────────────────────────
test('checkVerify: test file with assertions passes', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    const testContent = [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('something works', () => {",
      "  const val = 1 + 1;",
      "  assert.equal(val, 2);",
      "  assert.ok(true);",
      "  assert.ok(val > 0);",
      "  assert.ok(val < 10);",
      "  assert.equal(typeof val, 'number');",
      "  assert.ok(!isNaN(val));",
      "  assert.equal(val.toString(), '2');",
      "});",
    ].join('\n');
    writeFileSync(join(dir, 'src.test.js'), testContent);
    gitCommit(dir, 'add tests for core logic');
    const result = checkVerify(dir);
    assert.equal(result.score, 100, `Expected 100 but got ${result.score}: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 6. Test file with NO assertions → error ───────────────────────────────
test('checkVerify: test file with no assertions → error', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    const emptyTestContent = Array(12).fill(0).map((_, i) =>
      i === 0 ? "// TODO: add tests" : `// placeholder line ${i}`
    ).join('\n');
    writeFileSync(join(dir, 'auth.test.js'), emptyTestContent);
    gitCommit(dir, 'add auth.test.js');
    const result = checkVerify(dir);
    assert.ok(result.score < 100, `Expected score < 100, got ${result.score}`);
    assert.ok(result.issues.some(i => i.severity === 'error' && i.message.includes('no assertions')),
      `Expected error about no assertions, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 7. File exists but only 5 lines → warning ────────────────────────────
test('checkVerify: file with <10 lines → warning', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    const thinContent = 'const x = 1;\nconst y = 2;\nconst z = 3;\n';
    writeFileSync(join(dir, 'thin.js'), thinContent);
    gitCommit(dir, 'add thin.js');
    const result = checkVerify(dir);
    assert.ok(result.score < 100, `Expected score < 100, got ${result.score}`);
    assert.ok(result.issues.some(i => i.severity === 'warning' && i.message.includes('Thin file')),
      `Expected warning about thin file, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 8. Empty file → error ─────────────────────────────────────────────────
test('checkVerify: empty file → error', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'empty.js'), '');
    gitCommit(dir, 'add empty.js');
    const result = checkVerify(dir);
    assert.ok(result.score < 100, `Expected score < 100, got ${result.score}`);
    assert.ok(result.issues.some(i => i.severity === 'error' && i.message.includes('Empty file')),
      `Expected error about empty file, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 9. result.name === 'verify' ───────────────────────────────────────────
test('checkVerify: result.name is "verify"', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    const result = checkVerify(dir);
    assert.equal(result.name, 'verify');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 10. result.maxScore === 100 ───────────────────────────────────────────
test('checkVerify: result.maxScore is 100', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    const result = checkVerify(dir);
    assert.equal(result.maxScore, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 11. issues have correct severity type ─────────────────────────────────
test('checkVerify: issues have valid severity values', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'empty.ts'), '');
    gitCommit(dir, 'add empty.ts');
    const result = checkVerify(dir);
    const validSeverities = new Set(['error', 'warning', 'info']);
    for (const issue of result.issues) {
      assert.ok(validSeverities.has(issue.severity), `Invalid severity: ${issue.severity}`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 12. issues have fixHint ───────────────────────────────────────────────
test('checkVerify: issues have fixHint property', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'empty.ts'), '');
    gitCommit(dir, 'add empty.ts');
    const result = checkVerify(dir);
    for (const issue of result.issues) {
      assert.ok(typeof issue.fixHint === 'string', `Issue missing fixHint: ${JSON.stringify(issue)}`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 13. clean state → summary mentions 'verified' or 'no agent claims' ────
test('checkVerify: clean state has informative summary', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    const result = checkVerify(dir);
    assert.ok(
      result.summary.includes('verified') || result.summary.includes('no') || result.summary.includes('skipped'),
      `Unexpected summary: ${result.summary}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 14. test file detection via *.test.ts ─────────────────────────────────
test('checkVerify: detects *.test.ts as test file', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    // Write a .test.ts with no assertions
    const noAssertContent = Array(12).fill(0).map((_, i) => `// line ${i}`).join('\n');
    writeFileSync(join(dir, 'core.test.ts'), noAssertContent);
    gitCommit(dir, 'add core.test.ts');
    const result = checkVerify(dir);
    // Should detect as test file and flag missing assertions
    assert.ok(result.issues.some(i => i.message.includes('no assertions')),
      `Expected test file detection for .test.ts, issues: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 15. test file in __tests__/ dir ───────────────────────────────────────
test('checkVerify: detects __tests__/ directory as test files', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, '__tests__'));
    const noAssertContent = Array(12).fill(0).map((_, i) => `// line ${i}`).join('\n');
    writeFileSync(join(dir, '__tests__/core.js'), noAssertContent);
    gitCommit(dir, 'add __tests__/core.js');
    const result = checkVerify(dir);
    assert.ok(result.issues.some(i => i.message.includes('no assertions')),
      `Expected test detection for __tests__/, issues: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Python project: __init__.py not flagged as thin ───────────────────────
test('checkVerify: python __init__.py not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "myapp"');
    gitCommit(dir, 'initial');
    // __init__.py with only 2 lines — would normally be "thin"
    writeFileSync(join(dir, '__init__.py'), '# init\nfrom .core import main\n');
    gitCommit(dir, 'add __init__.py');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('__init__.py')),
      `__init__.py should not be flagged as thin in Python projects, got: ${JSON.stringify(result.issues)}`);
    assert.ok(result.summary.includes('python project'), `summary should mention python project`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Python project: .pyi stubs not flagged as thin ────────────────────────
test('checkVerify: python .pyi stubs not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    writeFileSync(join(dir, 'setup.py'), 'from setuptools import setup');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'types.pyi'), 'x: int\ny: str\n');
    gitCommit(dir, 'add types.pyi');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('types.pyi')),
      `.pyi stubs should not be flagged as thin in Python projects`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Non-Python project: thin source code files still flagged ──────────────
test('checkVerify: non-python project still flags thin source code files', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'app.ts'), '// stub\nexport const x = 1;\n');
    gitCommit(dir, 'add app.ts');
    const result = checkVerify(dir);
    assert.ok(result.issues.some(i => i.message.includes('Thin file')),
      `thin source code files should still be flagged`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Fix 1: Config/meta files excluded from thin file check ────────────────

test('checkVerify: .gitignore not flagged as thin file', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, '.gitignore'), 'node_modules\ndist\n');
    gitCommit(dir, 'add .gitignore');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('.gitignore')),
      `.gitignore should not be flagged as thin, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkVerify: config extensions (json, yml, toml) not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions": {}}');
    writeFileSync(join(dir, 'config.yml'), 'key: value\n');
    writeFileSync(join(dir, 'settings.toml'), '[section]\nkey = "val"\n');
    gitCommit(dir, 'add config files');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && (
      i.message.includes('.json') || i.message.includes('.yml') || i.message.includes('.toml')
    )), `Config files should not be flagged as thin, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkVerify: .github/ directory files not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github', 'FUNDING.yml'), 'github: user\n');
    gitCommit(dir, 'add .github/FUNDING.yml');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('.github')),
      `.github/ files should not be flagged as thin`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkVerify: LICENSE and CODEOWNERS not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'LICENSE'), 'MIT License\n');
    writeFileSync(join(dir, 'CODEOWNERS'), '* @owner\n');
    gitCommit(dir, 'add LICENSE and CODEOWNERS');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && (
      i.message.includes('LICENSE') || i.message.includes('CODEOWNERS')
    )), `META files should not be flagged as thin`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Fix 4: Non-code files never flagged as test without assertions ────────

test('checkVerify: .json file not flagged as test without assertions', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    // A file in __tests__/ that is JSON — should NOT be flagged as "test without assertions"
    mkdirSync(join(dir, '__tests__'));
    const content = Array(12).fill(0).map((_, i) => `"key${i}": ${i}`).join(',\n');
    writeFileSync(join(dir, '__tests__/fixtures.json'), `{${content}}`);
    gitCommit(dir, 'add __tests__/fixtures.json');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('no assertions') && i.message.includes('.json')),
      `JSON files should never be flagged as test without assertions, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkVerify: .svg and .lock files not flagged as test without assertions', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, '__tests__'));
    const svgContent = Array(12).fill(0).map((_, i) => `<!-- line ${i} -->`).join('\n');
    writeFileSync(join(dir, '__tests__/icon.svg'), `<svg>${svgContent}</svg>`);
    gitCommit(dir, 'add __tests__/icon.svg');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('no assertions')),
      `Non-code files should never be flagged as test without assertions`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── py.typed marker file not flagged ──────────────────────────────────────
test('checkVerify: py.typed marker file not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "test"');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'py.typed'), '');
    gitCommit(dir, 'add py.typed');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('py.typed')),
      'py.typed should not be flagged as thin/empty');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── .cff citation file not flagged ───────────────────────────────────────
test('checkVerify: .cff citation file not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'CITATION.cff'), 'cff-version: 1.2.0\ntitle: test');
    gitCommit(dir, 'add CITATION.cff');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('CITATION.cff')),
      '.cff files should not be flagged as thin');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── .mdc cursor rules not flagged ────────────────────────────────────────
test('checkVerify: .mdc cursor rules not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'rules.mdc'), 'some cursor rule');
    gitCommit(dir, 'add rules.mdc');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('rules.mdc')),
      '.mdc files should not be flagged as thin');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── .html files not flagged as thin ───────────────────────────────────────
test('checkVerify: .html files not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'page.html'), '<h1>Hello</h1>');
    gitCommit(dir, 'add page.html');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('page.html')),
      '.html files should not be flagged as thin');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── .txt files not flagged as thin ───────────────────────────────────────
test('checkVerify: .txt files not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    writeFileSync(join(dir, 'notes.txt'), 'some notes');
    gitCommit(dir, 'add notes.txt');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('notes.txt')),
      '.txt files should not be flagged as thin');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── __init__.py not flagged even without pyproject.toml ──────────────────
test('checkVerify: __init__.py not flagged even in non-python project', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg/__init__.py'), '');
    gitCommit(dir, 'add pkg/__init__.py');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('__init__.py')),
      '__init__.py should never be flagged as thin/empty');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Fix: __main__.py excluded from thin file check ────────────────────────
test('checkVerify: __main__.py not flagged as thin file', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "myapp"');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, 'myapp'), { recursive: true });
    writeFileSync(join(dir, 'myapp/__main__.py'), 'from .cli import main\n\nmain()\n');
    gitCommit(dir, 'add __main__.py');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('__main__.py')),
      `__main__.py should not be flagged as thin, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Fix: examples/ directory excluded from thin file check ────────────────
test('checkVerify: files in examples/ not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, 'examples'), { recursive: true });
    writeFileSync(join(dir, 'examples/demo.py'), 'print("hello")\n');
    gitCommit(dir, 'add examples/demo.py');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('examples/')),
      `Files in examples/ should not be flagged as thin, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkVerify: files in docs/ not flagged as thin', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.py'), 'x = 1\n');
    gitCommit(dir, 'add docs/guide.py');
    const result = checkVerify(dir);
    assert.ok(!result.issues.some(i => i.message.includes('Thin file') && i.message.includes('docs/')),
      `Files in docs/ should not be flagged as thin, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 16. score is bounded 0-100 ────────────────────────────────────────────
test('checkVerify: score is always between 0 and 100', async () => {
  const dir = makeTmpDir();
  try {
    gitInit(dir);
    writeFileSync(join(dir, 'README.md'), 'hello');
    gitCommit(dir, 'initial');
    // Create many problematic files
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, `empty${i}.js`), '');
    }
    gitCommit(dir, 'add empty files');
    const result = checkVerify(dir);
    assert.ok(result.score >= 0 && result.score <= 100,
      `Score out of bounds: ${result.score}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
