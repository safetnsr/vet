import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  groupActions,
  computeSha256,
  renderReceiptText,
  renderReceiptJson,
  findSessionFiles,
  parseSessionFile,
} = await import('../src/checks/receipt.ts');

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'vet-receipt-'));
}

const SAMPLE_JSONL = [
  JSON.stringify({ timestamp: '2024-01-01T10:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'Write', input: { file_path: 'src/index.ts' } }] } }),
  JSON.stringify({ timestamp: '2024-01-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'Edit', input: { file_path: 'src/utils.ts' } }] } }),
  JSON.stringify({ timestamp: '2024-01-01T10:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: '3', name: 'exec', input: { command: 'npm install typescript' } }] } }),
  JSON.stringify({ timestamp: '2024-01-01T10:03:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: '4', name: 'web_fetch', input: { url: 'https://docs.example.com' } }] } }),
].join('\n');

test('groupActions: correctly categorizes tool uses', async () => {
  const dir = makeTmpDir();
  const sessionPath = join(dir, 'abc123.jsonl');
  try {
    writeFileSync(sessionPath, SAMPLE_JSONL);
    const { toolUses, entries } = await parseSessionFile(sessionPath);
    const actions = groupActions(toolUses, entries, sessionPath);

    assert.deepEqual(actions.files_created, ['src/index.ts']);
    assert.deepEqual(actions.files_modified, ['src/utils.ts']);
    assert.ok(actions.commands_run.some(c => c.includes('npm install')));
    assert.ok(actions.packages_installed.includes('typescript'));
    assert.ok(actions.urls_fetched.includes('https://docs.example.com'));
    assert.equal(actions.session_id, 'abc123');
    assert.equal(actions.duration_seconds, 180);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('computeSha256: produces consistent hash', () => {
  const h1 = computeSha256('hello world');
  const h2 = computeSha256('hello world');
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
  assert.notEqual(computeSha256('hello world'), computeSha256('hello world!'));
});

test('renderReceiptText: contains session ID and sections', async () => {
  const dir = makeTmpDir();
  const sessionPath = join(dir, 'mysession.jsonl');
  try {
    writeFileSync(sessionPath, SAMPLE_JSONL);
    const { toolUses, entries } = await parseSessionFile(sessionPath);
    const actions = groupActions(toolUses, entries, sessionPath);
    const text = renderReceiptText(actions);

    assert.ok(text.includes('AGENT SESSION RECEIPT'));
    assert.ok(text.includes('mysession'));
    assert.ok(text.includes('FILES CREATED'));
    assert.ok(text.includes('SHA256'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('renderReceiptJson: contains sha256 and actions', async () => {
  const dir = makeTmpDir();
  const sessionPath = join(dir, 'mysession.jsonl');
  try {
    writeFileSync(sessionPath, SAMPLE_JSONL);
    const { toolUses, entries } = await parseSessionFile(sessionPath);
    const actions = groupActions(toolUses, entries, sessionPath);
    const receipt = renderReceiptJson(actions);

    assert.ok(receipt.sha256, 'sha256 should be present');
    assert.equal(receipt.sha256.length, 64);
    assert.ok(receipt.generated_at);
    assert.deepEqual(receipt.actions.files_created, ['src/index.ts']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('findSessionFiles: returns empty array when dir does not exist', () => {
  const files = findSessionFiles('/nonexistent/path/that/does/not/exist');
  assert.deepEqual(files, []);
});

test('parseSessionFile: handles malformed lines gracefully', async () => {
  const dir = makeTmpDir();
  const sessionPath = join(dir, 'broken.jsonl');
  try {
    writeFileSync(sessionPath, 'not json\n' + JSON.stringify({ timestamp: '2024-01-01T10:00:00Z' }) + '\nalso not json');
    const { toolUses, entries } = await parseSessionFile(sessionPath);
    assert.equal(toolUses.length, 0);
    assert.equal(entries.length, 1); // one valid JSON line
  } finally {
    rmSync(dir, { recursive: true });
  }
});
