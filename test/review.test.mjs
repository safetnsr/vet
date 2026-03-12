import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { checkReview, runReviewCommand } from '../dist/checks/review.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vet-review-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const FULL_REVIEW = `# Review Guide

## Focus Areas
Please focus on error handling and security patterns.
Check for proper input validation.

## Out of Scope
Ignore styling changes and CSS modifications.
Skip documentation-only changes.

## Persona
You are a senior security reviewer.
Act as a domain expert in authentication.

## Tools
Allowed tools: grep, ast-grep.
Disallowed: web browser.

## Examples
\`\`\`
// Good review comment:
// SECURITY: This endpoint lacks rate limiting — add express-rate-limit middleware
\`\`\`
`;

describe('checkReview', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // 1. No REVIEW.md → score 0, info issue
  it('no REVIEW.md returns score 0 with info issue', async () => {
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 0);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].severity, 'info');
    assert.ok(result.issues[0].message.includes('No REVIEW.md found'));
  });

  // 2. Empty REVIEW.md → score 0
  it('empty REVIEW.md returns score 0', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), '');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 0);
  });

  // 3. Full REVIEW.md → score 100
  it('REVIEW.md with all 5 sections returns score 100', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), FULL_REVIEW);
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 100);
  });

  // 4. Only focus areas → score 20
  it('REVIEW.md with only focus areas returns score 20', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Please focus on error handling.');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 20);
  });

  // 5. Focus + examples → score 40
  it('REVIEW.md with focus + examples returns score 40', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Check for bugs.\n```\n// example comment\n```\n');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 40);
  });

  // 6. Out-of-scope only → score 20
  it('REVIEW.md with out-of-scope only returns score 20', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Ignore CSS changes. Skip formatting.');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 20);
  });

  // 7. Persona only → score 20
  it('REVIEW.md with persona only returns score 20', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'You are a security reviewer.');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 20);
  });

  // 8. Tool list only → score 20
  it('REVIEW.md with tool list only returns score 20', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Allowed tools: grep and ripgrep.');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 20);
  });

  // 9. Case insensitive matching
  it('case insensitive matching works', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'FOCUS on security. IGNORE styling.');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 40); // focus areas + out-of-scope
  });

  // 10. Multiple REVIEW.md files → average score
  it('multiple REVIEW.md files returns average score', async () => {
    // File 1: score 100 (all sections)
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), FULL_REVIEW);
    // File 2: score 0 (empty) in subdir
    const subdir = path.join(tmpDir, 'packages', 'core');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'REVIEW.md'), '');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 50); // average of 100 and 0
  });

  // 11. Nested REVIEW.md in subdir found
  it('nested REVIEW.md in subdir is found', async () => {
    const subdir = path.join(tmpDir, 'src');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'REVIEW.md'), FULL_REVIEW);
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 100);
  });

  // 12. checkReview returns correct CheckResult shape
  it('returns correct CheckResult shape', async () => {
    const result = await checkReview(tmpDir);
    assert.ok('name' in result);
    assert.ok('score' in result);
    assert.ok('maxScore' in result);
    assert.ok('issues' in result);
    assert.ok('summary' in result);
    assert.equal(result.name, 'review');
    assert.equal(result.maxScore, 100);
  });

  // 13. Issues have correct severity
  it('info severity for missing file, warning for partial', async () => {
    // Missing file → info
    const r1 = await checkReview(tmpDir);
    assert.equal(r1.issues[0].severity, 'info');

    // Partial file → warning
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Focus on security.');
    const r2 = await checkReview(tmpDir);
    assert.ok(r2.issues.some(i => i.severity === 'warning'));
  });

  // 14. REVIEW.md with code block → examples check passes
  it('code block triggers examples check', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), '```\nsome example\n```');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 20); // only examples pass
  });

  // 15. Varied phrasing for focus areas
  it('varied phrasing triggers focus areas', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Pay attention to error handling. Concentrate on performance.');
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 20); // focus areas pass
  });

  // 16. Deep nested beyond max depth not found
  it('REVIEW.md beyond max depth 3 not found', async () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'REVIEW.md'), FULL_REVIEW);
    const result = await checkReview(tmpDir);
    assert.equal(result.score, 0);
    assert.equal(result.issues[0].severity, 'info');
  });
});

describe('runReviewCommand', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('json format outputs valid JSON', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), FULL_REVIEW);
    const original = console.log;
    let output = '';
    console.log = (msg) => { output += msg; };
    try {
      await runReviewCommand(tmpDir, 'json');
      const parsed = JSON.parse(output);
      assert.ok('files' in parsed);
      assert.ok('score' in parsed);
      assert.equal(parsed.score, 100);
    } finally {
      console.log = original;
    }
  });

  it('ascii format runs without error', async () => {
    fs.writeFileSync(path.join(tmpDir, 'REVIEW.md'), 'Focus on bugs.');
    const original = console.log;
    const lines = [];
    console.log = (msg) => { lines.push(msg); };
    try {
      await runReviewCommand(tmpDir, 'ascii');
      assert.ok(lines.length > 0);
    } finally {
      console.log = original;
    }
  });
});
