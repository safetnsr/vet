import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { checkSecrets } = await import('../src/checks/secrets.ts');

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'vet-secrets-'));
}

test('checkSecrets: clean project returns score 10', async () => {
  const dir = makeTmpDir();
  try {
    const result = await checkSecrets(dir);
    assert.equal(result.name, 'secrets');
    assert.equal(result.maxScore, 10);
    assert.equal(result.score, 10);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkSecrets: detects Anthropic key in .env', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGH12345678901234567890123456789012345678');
    const result = await checkSecrets(dir);
    assert.ok(result.score < 10, 'score should drop when key found');
    assert.ok(result.issues.some(i => i.message.includes('Anthropic')), 'should mention Anthropic');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkSecrets: detects leaked GitHub token in build output', async () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'var token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901";');
    const result = await checkSecrets(dir);
    assert.ok(result.issues.some(i => i.message.includes('GitHub Token')), 'should detect GitHub token');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkSecrets: source map in build dir is flagged', async () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bundle.js.map'), '{"version":3,"sources":["src/secret.ts"]}');
    const result = await checkSecrets(dir);
    assert.ok(result.issues.some(i => i.message.includes('Source Map')), 'source map should be flagged');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkSecrets: .env in subdirectory is found', async () => {
  const dir = makeTmpDir();
  try {
    mkdirSync(join(dir, 'packages', 'api'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'api', '.env'), 'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno');
    const result = await checkSecrets(dir);
    assert.ok(result.issues.some(i => i.message.includes('OpenAI')), 'should find OpenAI key in nested .env');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('checkSecrets: no build dir noted in summary', async () => {
  const dir = makeTmpDir();
  try {
    const result = await checkSecrets(dir);
    assert.ok(result.summary.includes('no build dir found'), 'should note no build dir');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
