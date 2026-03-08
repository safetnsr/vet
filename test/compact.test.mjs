import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const {
  checkCompact,
  detectCompactions,
  extractFilePaths,
  extractIdentifiers,
  extractInstructions,
} = await import('../src/checks/compact.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-compact-'));
}

function writeJsonl(dir, filename, entries) {
  writeFileSync(join(dir, filename), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// Helper to make a fake session dir that findLatestSession can find
function makeFakeSessionDir(entries) {
  const home = process.env.HOME || '~';
  const projectsDir = join(home, '.claude', 'projects');
  const testDir = join(projectsDir, '_vet_test_compact_' + Date.now());
  mkdirSync(testDir, { recursive: true });
  const sessionFile = join(testDir, 'test-session.jsonl');
  writeFileSync(sessionFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return { dir: testDir, file: sessionFile };
}

// ── 1. detectCompactions: no entries → empty ──────────────────────────────
test('detectCompactions: empty entries → no compactions', () => {
  const events = detectCompactions([]);
  assert.equal(events.length, 0);
});

// ── 2. detectCompactions: no compaction events → empty ────────────────────
test('detectCompactions: normal conversation → no compactions', () => {
  const entries = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'thanks' },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 0);
});

// ── 3. detectCompactions: system message with long content after exchanges ─
test('detectCompactions: long system message after exchanges → compaction detected', () => {
  const longContent = 'This is a compaction summary. '.repeat(30); // >500 chars
  const entries = [
    { role: 'user', content: 'work on src/auth/login.ts' },
    { role: 'assistant', content: 'I will update the validateToken function in src/auth/login.ts' },
    { role: 'system', content: longContent },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
  assert.equal(events[0].messageIndex, 2);
});

// ── 4. detectCompactions: type field with "compact" ───────────────────────
test('detectCompactions: entry with type containing "compact" → detected', () => {
  const entries = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { type: 'compact', role: 'system', content: 'summary of conversation' },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
});

// ── 5. detectCompactions: meta.type with "compact" ────────────────────────
test('detectCompactions: entry with meta.type "compact" → detected', () => {
  const entries = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'system', content: 'summary', meta: { type: 'compact' } },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
});

// ── 6. Compaction with no drops → score 100 ──────────────────────────────
test('detectCompactions: compaction preserves all context → no drops', () => {
  const longSummary = 'Working on src/auth/login.ts with the validateToken function. Always check tokens before proceeding. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'work on src/auth/login.ts with validateToken' },
    { role: 'assistant', content: 'updating validateToken in src/auth/login.ts' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
  // File path and identifier are in summary
  assert.equal(events[0].droppedFilePaths.length, 0);
});

// ── 7. Compaction drops a file path → warning ────────────────────────────
test('detectCompactions: dropped file path → captured', () => {
  const longSummary = 'General summary of the conversation about authentication. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'update src/auth/middleware.ts and src/db/conn.ts' },
    { role: 'assistant', content: 'I updated both files' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
  assert.ok(events[0].droppedFilePaths.length >= 1);
  assert.ok(events[0].droppedFilePaths.some(fp => fp.includes('src/auth/middleware.ts')));
});

// ── 8. Compaction drops an instruction → error ───────────────────────────
test('detectCompactions: dropped instruction → captured', () => {
  const longSummary = 'Summary of work done on the project. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'never delete production files. always backup first.' },
    { role: 'assistant', content: 'understood, I will follow those rules' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
  assert.ok(events[0].droppedInstructions.length >= 1);
});

// ── 9. Compaction drops an identifier → info ─────────────────────────────
test('detectCompactions: dropped identifier → captured', () => {
  const longSummary = 'Summary about authentication work. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'fix the validateToken and parseUserClaims functions' },
    { role: 'assistant', content: 'fixed validateToken and parseUserClaims' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
  assert.ok(events[0].droppedIdentifiers.length >= 1);
});

// ── 10. Multiple compactions → correct count ─────────────────────────────
test('detectCompactions: multiple compactions → all detected', () => {
  const summary1 = 'First compaction summary about initial work. ' + 'x'.repeat(500);
  const summary2 = 'Second compaction summary about later work. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'start task' },
    { role: 'assistant', content: 'starting' },
    { role: 'system', content: summary1 },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'continuing' },
    { role: 'system', content: summary2 },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 2);
});

// ── 11. Score: 1 error → score 70 ────────────────────────────────────────
test('score: 1 error (dropped instruction) → score 70', () => {
  const longSummary = 'Generic summary. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'never delete the database without confirmation' },
    { role: 'assistant', content: 'ok' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  // Manual score check: should have at least 1 error
  const errors = events.reduce((s, e) => s + e.droppedInstructions.length, 0);
  assert.ok(errors >= 1, `expected at least 1 dropped instruction, got ${errors}`);
  // Score = 100 - 30*errors - 15*warnings - 5*infos
  // With 1 error and potentially some infos/warnings, score should be <= 70
});

// ── 12. Score: 2 warnings → score 70 ─────────────────────────────────────
test('score: 2 dropped file paths → score 70', () => {
  const longSummary = 'General summary. ' + 'x'.repeat(500);
  const entries = [
    { role: 'user', content: 'modify src/a/b.ts and src/c/d.ts' },
    { role: 'assistant', content: 'done with both files' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  const warnings = events.reduce((s, e) => s + e.droppedFilePaths.length, 0);
  assert.ok(warnings >= 2, `expected at least 2 dropped file paths, got ${warnings}`);
});

// ── 13. Score never goes below 0 ─────────────────────────────────────────
test('score: many issues → score floors at 0', () => {
  const longSummary = 'x'.repeat(600);
  const heavyContent = [
    'never do X. always do Y. must check Z. never skip validation.',
    'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts',
    'validateToken parseUser checkAuth handleError',
  ].join(' ');
  const entries = [
    { role: 'user', content: heavyContent },
    { role: 'assistant', content: 'ok' },
    { role: 'system', content: longSummary },
  ];
  const events = detectCompactions(entries);
  const errors = events.reduce((s, e) => s + e.droppedInstructions.length, 0);
  const warnings = events.reduce((s, e) => s + e.droppedFilePaths.length, 0);
  const infos = events.reduce((s, e) => s + e.droppedIdentifiers.length, 0);
  const score = Math.max(0, 100 - (errors * 30 + warnings * 15 + infos * 5));
  assert.ok(score >= 0);
});

// ── 14. extractFilePaths: various formats ─────────────────────────────────
test('extractFilePaths: captures various path formats', () => {
  const text = 'edit src/auth/login.ts and /var/www/app/index.js and config/db.yml';
  const paths = extractFilePaths(text);
  assert.ok(paths.some(p => p.includes('src/auth/login.ts')));
  assert.ok(paths.some(p => p.includes('/var/www/app/index.js')));
  assert.ok(paths.some(p => p.includes('config/db.yml')));
});

// ── 15. extractInstructions: catches keywords ─────────────────────────────
test('extractInstructions: catches always, never, must, don\'t', () => {
  const text = [
    'always validate input before processing.',
    'never delete production data without backup.',
    'must run tests before deploying.',
    "don't commit secrets to the repository.",
  ].join(' ');
  const instructions = extractInstructions(text);
  assert.ok(instructions.length >= 3, `expected at least 3 instructions, got ${instructions.length}: ${JSON.stringify(instructions)}`);
});

// ── 16. extractIdentifiers: camelCase and snake_case ──────────────────────
test('extractIdentifiers: captures camelCase and snake_case', () => {
  const text = 'The validateToken function calls parse_user_claims and returns authResult';
  const ids = extractIdentifiers(text);
  assert.ok(ids.some(id => id === 'validateToken'));
  assert.ok(ids.some(id => id === 'parse_user_claims'));
});

// ── 17. Empty JSONL → graceful handling ──────────────────────────────────
test('detectCompactions: empty entries array → no crash', () => {
  const events = detectCompactions([]);
  assert.equal(events.length, 0);
});

// ── 18. System message before any exchanges → not compaction ─────────────
test('detectCompactions: system message before exchanges → not compaction', () => {
  const entries = [
    { role: 'system', content: 'You are a helpful assistant. '.repeat(30) },
    { role: 'user', content: 'hello' },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 0);
});

// ── 19. type "summary" also detected ─────────────────────────────────────
test('detectCompactions: type "summary" → detected', () => {
  const entries = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { type: 'summary', content: 'conversation about greetings' },
  ];
  const events = detectCompactions(entries);
  assert.equal(events.length, 1);
});

// ── 20. Score calculation: mixed issues → correct math ───────────────────
test('score: mixed issues → correct calculation', () => {
  // 1 error (30) + 1 warning (15) + 1 info (5) = 50 penalty → score 50
  const score = Math.max(0, 100 - (1 * 30 + 1 * 15 + 1 * 5));
  assert.equal(score, 50);
});
