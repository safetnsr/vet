import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { checkModels } = await import('../src/checks/models.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-models-'));
}

// ── AI framework detection ────────────────────────────────────────────────

test('checkModels: AI framework package downgrades findings to info', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@vercel/ai',
      keywords: ['ai', 'llm'],
    }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'providers.ts'), 'const model = "gpt-3.5-turbo";\nconst old = "claude-2";\n');
    const result = await checkModels(dir, []);
    assert.equal(result.name, 'models');
    // All findings should be info, not error
    for (const issue of result.issues) {
      assert.equal(issue.severity, 'info', `AI framework findings should be info, got: ${issue.severity}`);
    }
    assert.ok(result.score >= 70, `AI framework score should be >= 70, got: ${result.score}`);
    assert.ok(result.summary.includes('AI framework detected'), `Summary should mention AI framework`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkModels: AI framework via keywords detection', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'my-tool',
      keywords: ['language-model', 'openai'],
    }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const DEFAULT = "gpt-3.5-turbo";');
    const result = await checkModels(dir, []);
    assert.ok(result.score >= 70, `AI framework score should be >= 70`);
    assert.ok(result.summary.includes('AI framework detected'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Test/docs file downgrading ────────────────────────────────────────────

test('checkModels: deprecated model in test file is info severity', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'api.test.ts'), 'const model = "gpt-3.5-turbo";');
    const result = await checkModels(dir, []);
    for (const issue of result.issues) {
      assert.equal(issue.severity, 'info', `Test file findings should be info`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkModels: deprecated model in examples/ is info severity', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    mkdirSync(join(dir, 'examples'));
    writeFileSync(join(dir, 'examples', 'demo.js'), 'const model = "gpt-3.5-turbo";');
    const result = await checkModels(dir, []);
    for (const issue of result.issues) {
      assert.equal(issue.severity, 'info', `Example file findings should be info`);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Normal project: deprecated model in src is error ──────────────────────

test('checkModels: deprecated model in regular src is error', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-web-app' }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'config.ts'), 'export const MODEL = "gpt-3.5-turbo";');
    const result = await checkModels(dir, []);
    assert.ok(result.issues.some(i => i.severity === 'error'), `Should have error severity for regular src`);
    assert.ok(result.score < 100, `Score should be penalized for deprecated models, got: ${result.score}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Monorepo AI framework detection ───────────────────────────────────────

test('checkModels: detects AI framework from subdirectory pyproject.toml', async () => {
  const dir = makeTmpDir();
  try {
    // No root package.json — monorepo style, pyproject in direct subdirectory
    mkdirSync(join(dir, 'core'), { recursive: true });
    writeFileSync(join(dir, 'core/pyproject.toml'), '[project]\nname = "core"\ndependencies = ["langchain"]');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'config.py'), 'MODEL = "gpt-3.5-turbo"');
    const result = await checkModels(dir, []);
    // Should detect as AI framework → info severity, floor at 70
    const gpt35Issue = result.issues.find(i => i.message.includes('gpt-3.5-turbo'));
    if (gpt35Issue) {
      assert.equal(gpt35Issue.severity, 'info', 'AI framework should downgrade to info');
    }
    assert.ok(result.score >= 70, `AI framework score should be >= 70, got ${result.score}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkModels: detects AI framework from deep monorepo pyproject.toml', async () => {
  const dir = makeTmpDir();
  try {
    // Simulate langchain monorepo structure: libs/langchain/pyproject.toml
    mkdirSync(join(dir, 'libs', 'core'), { recursive: true });
    writeFileSync(join(dir, 'libs', 'core', 'pyproject.toml'), '[project]\nname = "langchain-core"\ndependencies = ["langchain"]');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'config.py'), 'MODEL = "gpt-3.5-turbo"');
    const result = await checkModels(dir, []);
    assert.ok(result.score >= 70, `Deep monorepo AI framework should score >= 70, got ${result.score}`);
    assert.ok(result.summary.includes('AI framework detected'), `Should detect AI framework from deep pyproject.toml`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkModels: detects AI framework from directory name', async () => {
  const parent = mkdtempSync(join(osTmpdir(), 'vet-models-'));
  const dir = join(parent, 'langchain');
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'config.py'), 'MODEL = "gpt-3.5-turbo"');
    const result = await checkModels(dir, []);
    assert.ok(result.summary.includes('AI framework') || result.score >= 70,
      `Should detect AI framework from dir name 'langchain', got score ${result.score}`);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test('checkModels: detects AI framework from CLAUDE.md mentioning LLM terms', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Instructions\nThis is an LLM-powered app using embeddings and RAG.');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'config.ts'), 'const MODEL = "gpt-3.5-turbo";');
    const result = await checkModels(dir, []);
    assert.ok(result.score >= 70, `AI framework via CLAUDE.md should score >= 70, got ${result.score}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── Clean project ─────────────────────────────────────────────────────────

test('checkModels: no deprecated models returns score 100', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const MODEL = "gpt-4o";');
    const result = await checkModels(dir, []);
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
