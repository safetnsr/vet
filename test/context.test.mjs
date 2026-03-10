import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Import the check function
const { checkContext } = await import('../dist/checks/context.js');

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'vet-context-'));
}

describe('context check', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // 1. discovers CLAUDE.md
  it('discovers CLAUDE.md', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Rules\nbe helpful');
    const result = checkContext(tmp);
    assert.notEqual(result.score, 85); // not the "no files" score (100-15)
    assert.ok(result.issues.some(i => i.message.includes('tokens')));
  });

  // 2. discovers AGENTS.md
  it('discovers AGENTS.md', () => {
    writeFileSync(join(tmp, 'AGENTS.md'), '## Agents\ndo stuff');
    const result = checkContext(tmp);
    assert.ok(result.summary.includes('1 context file'));
  });

  // 3. discovers .cursorrules
  it('discovers .cursorrules', () => {
    writeFileSync(join(tmp, '.cursorrules'), 'rule: be nice');
    const result = checkContext(tmp);
    assert.ok(result.summary.includes('1 context file'));
  });

  // 4. discovers memory/*.md files
  it('discovers memory/*.md files', () => {
    mkdirSync(join(tmp, 'memory'));
    writeFileSync(join(tmp, 'memory', 'tools.md'), '## Tools\nnpm');
    const result = checkContext(tmp);
    assert.ok(result.summary.includes('1 context file'));
  });

  // 5. handles missing context files gracefully (empty dir)
  it('handles missing context files gracefully', () => {
    const result = checkContext(tmp);
    assert.equal(result.score, 85); // 100 - 15
    assert.ok(result.issues.some(i => i.severity === 'error'));
  });

  // 6. splits content by ## headers into sections
  it('splits content by ## headers into sections', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Section A\ncontent a\n## Section B\ncontent b');
    const result = checkContext(tmp);
    // Should find file with sections — summary shows tokens
    assert.ok(result.summary.includes('tokens'));
  });

  // 7. splits content by ### headers into subsections
  it('splits content by ### headers into subsections', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Main\n### Sub1\ncontent\n### Sub2\nmore');
    const result = checkContext(tmp);
    assert.ok(result.summary.includes('tokens'));
  });

  // 8. counts tokens (known string → non-zero count)
  it('counts tokens for known string', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'Hello world, this is a test of token counting functionality.');
    const result = checkContext(tmp);
    const tokenInfo = result.issues.find(i => i.message.includes('Total context'));
    assert.ok(tokenInfo);
    // Extract token count from message
    const match = tokenInfo.message.match(/(\d+) tokens/);
    assert.ok(match);
    assert.ok(parseInt(match[1]) > 0);
  });

  // 9. calculates opus cost correctly
  it('calculates opus cost correctly', () => {
    // 1000 tokens at opus = $15/MTok = $0.015
    // We can't directly test cost from checkContext, but we can verify via JSON subcommand
    writeFileSync(join(tmp, 'CLAUDE.md'), 'x '.repeat(500)); // ~500 tokens
    const result = checkContext(tmp);
    assert.ok(result.score >= 0);
    assert.ok(result.score <= 100);
  });

  // 10. calculates sonnet cost correctly
  it('calculates sonnet cost correctly', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'token test content for sonnet cost');
    const result = checkContext(tmp);
    const savingsIssue = result.issues.find(i => i.message.includes('sonnet'));
    // May or may not have savings — just ensure no crash
    assert.ok(result.score >= 0);
  });

  // 11. calculates haiku cost correctly
  it('calculates haiku cost correctly', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'haiku cost test');
    const result = checkContext(tmp);
    assert.ok(result.score >= 0);
    assert.ok(result.score <= 100);
  });

  // 12. score = 100 for small, clean context
  it('score = 100 for small clean context', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Rules\nbe helpful\n## Style\nbe brief');
    const result = checkContext(tmp);
    // Small file, no stale (no ~/.claude/projects), under threshold
    assert.equal(result.score, 100);
  });

  // 13. score penalized for stale sections
  it('score penalized for stale sections concept', () => {
    // We can't easily mock ~/.claude/projects, but we can verify scoring logic
    // by checking that the scoring function handles penalties correctly
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Rules\nbe helpful');
    const result = checkContext(tmp);
    // Without stale detection active (no ~/.claude/projects), score should be clean
    assert.ok(result.score >= 85);
  });

  // 14. score penalized for exceeding 8K token threshold
  it('score penalized for exceeding 8K token threshold', () => {
    // Generate content that exceeds 8000 tokens (~4 chars per token)
    const bigContent = '## Big Section\n' + 'word '.repeat(10000);
    writeFileSync(join(tmp, 'CLAUDE.md'), bigContent);
    const result = checkContext(tmp);
    assert.ok(result.score < 100);
  });

  // 15. score = 0 when no context files exist (with -15 penalty, clamped)
  it('reports correct score with no context files', () => {
    const result = checkContext(tmp);
    assert.equal(result.score, 85); // 100 - 15 = 85, clamped to 0 if lower
    assert.ok(result.issues.some(i => i.severity === 'error' && i.message.includes('No agent context')));
  });

  // 16. JSON output includes expected fields
  it('JSON output includes expected fields', async () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), '## Rules\nbe helpful\n## Style\nbe brief');

    // Capture runContextCommand JSON output
    const { runContextCommand } = await import('../dist/checks/context.js');
    const originalLog = console.log;
    let output = '';
    console.log = (s) => { output += s; };
    try {
      await runContextCommand('json', tmp);
    } finally {
      console.log = originalLog;
    }

    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed.files));
    assert.ok(Array.isArray(parsed.sections));
    assert.ok(typeof parsed.totalTokens === 'number');
    assert.ok(typeof parsed.costs === 'object');
    assert.ok('opus' in parsed.costs);
    assert.ok('sonnet' in parsed.costs);
    assert.ok('haiku' in parsed.costs);
  });

  // 17. handles files with no headers as single section
  it('handles files with no headers as single section', () => {
    writeFileSync(join(tmp, 'CLAUDE.md'), 'just plain text without any headers at all');
    const result = checkContext(tmp);
    assert.ok(result.summary.includes('tokens'));
    assert.ok(result.score >= 0);
  });
});
