import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { checkSubsidy, runSubsidyCommand, computeSubsidy } = await import('../src/checks/subsidy.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-subsidy-'));
}

function writeSession(dir, filename, entries) {
  const sessionDir = join(dir, '.claude', 'projects', 'test');
  mkdirSync(sessionDir, { recursive: true });
  const filePath = join(sessionDir, filename);
  writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return filePath;
}

// ── 1. no session files → score 100, info message ─────────────────────────
test('checkSubsidy: no session files → score 100', async () => {
  const dir = makeTmpDir();
  try {
    // Point HOME to empty dir so findSessionFiles finds nothing
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    const result = await checkSubsidy(dir);
    process.env.HOME = origHome;
    assert.equal(result.score, 100);
    assert.equal(result.issues[0].severity, 'info');
    assert.match(result.issues[0].message, /no session logs found/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 2. session with usage data → correct cost calculation ─────────────────
test('computeSubsidy: session with usage data → correct cost', () => {
  const entries = [
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  // input: 1M * $3/1M = $3, output: 1M * $15/1M = $15
  assert.equal(result.totalCost, 18);
  assert.equal(result.models['claude-sonnet-4-6'].cost, 18);
});

// ── 3. pricing accuracy for claude-opus-4-6 ───────────────────────────────
test('computeSubsidy: claude-opus-4-6 pricing', () => {
  const entries = [
    { type: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  // input: $15 + output: $75 = $90
  assert.equal(result.totalCost, 90);
});

// ── 4. pricing accuracy for claude-sonnet-4-6 ─────────────────────────────
test('computeSubsidy: claude-sonnet-4-6 pricing', () => {
  const entries = [
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 2_000_000, output_tokens: 500_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  // input: 2 * $3 = $6, output: 0.5 * $15 = $7.5
  assert.equal(result.totalCost, 13.5);
});

// ── 5. unknown model → fallback pricing ───────────────────────────────────
test('computeSubsidy: unknown model → fallback pricing', () => {
  const entries = [
    { type: 'assistant', model: 'some-future-model', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  // fallback: input $3 + output $15 = $18
  assert.equal(result.totalCost, 18);
});

// ── 6. multiple models → per-model breakdown correct ──────────────────────
test('computeSubsidy: multiple models breakdown', () => {
  const entries = [
    { type: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    { type: 'assistant', model: 'claude-haiku-3-5', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  assert.equal(result.models['claude-opus-4-6'].cost, 90);    // $15 + $75
  assert.equal(result.models['claude-haiku-3-5'].cost, 4.8);  // $0.80 + $4
  assert.equal(result.totalCost, 94.8);
});

// ── 7. ASCII card rendering contains expected fields ──────────────────────
test('runSubsidyCommand: ASCII card contains key fields', async () => {
  const dir = makeTmpDir();
  try {
    writeSession(dir, 'session1.jsonl', [
      { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500 } },
    ]);
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    const origLog = console.log;
    let output = '';
    console.log = (s) => { output += s + '\n'; };
    await runSubsidyCommand('ascii', { plan: 'claude-pro' });
    console.log = origLog;
    process.env.HOME = origHome;
    assert.match(output, /YOUR AI COST THIS MONTH/);
    assert.match(output, /sessions analyzed/);
    assert.match(output, /USED \(list price\)/);
    assert.match(output, /PAID \(subscription\)/);
    assert.match(output, /SUBSIDIZED/);
    assert.match(output, /SUBSIDY RATE/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 8. JSON output has correct shape ──────────────────────────────────────
test('runSubsidyCommand: JSON output shape', async () => {
  const dir = makeTmpDir();
  try {
    writeSession(dir, 'session1.jsonl', [
      { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500 } },
    ]);
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    const origLog = console.log;
    let output = '';
    console.log = (s) => { output += s + '\n'; };
    await runSubsidyCommand('json', { plan: 'claude-pro' });
    console.log = origLog;
    process.env.HOME = origHome;
    const data = JSON.parse(output.trim());
    assert.ok('sessionCount' in data);
    assert.ok('totalCost' in data);
    assert.ok('subscriptionCost' in data);
    assert.ok('subsidized' in data);
    assert.ok('subsidyRate' in data);
    assert.ok('models' in data);
    assert.ok('periodStart' in data);
    assert.ok('periodEnd' in data);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 9. subscription tier: claude-pro = $20 ────────────────────────────────
test('computeSubsidy: claude-pro subscription = $20', () => {
  const entries = [
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  assert.equal(result.subscriptionCost, 20);
});

// ── 10. subscription tier: claude-max-20x = $200 ──────────────────────────
test('computeSubsidy: claude-max-20x subscription = $200', () => {
  const entries = [
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  ];
  const result = computeSubsidy(entries, 'claude-max-20x');
  assert.equal(result.subscriptionCost, 200);
});

// ── 11. subsidy rate math ─────────────────────────────────────────────────
test('computeSubsidy: subsidy rate math (used $100, paid $20 → 80%)', () => {
  // We need input to cost exactly $100 with sonnet-4-6: input $3/1M
  // $100 total with only input: 100/3 * 1M = 33_333_333.33 tokens
  // Easier: use output only. $15/1M output. Need $100 → ~6_666_667 tokens
  // Let's just verify math on a known result
  const entries = [
    { type: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 0, output_tokens: 1_333_333 } },
  ];
  // output cost: 1_333_333 / 1_000_000 * 75 = $99.999975 ≈ $100
  const result = computeSubsidy(entries, 'claude-pro');
  const expectedCost = (1_333_333 / 1_000_000) * 75;
  assert.ok(Math.abs(result.totalCost - expectedCost) < 0.01);
  assert.equal(result.subscriptionCost, 20);
  const expectedSubsidy = expectedCost - 20;
  assert.ok(Math.abs(result.subsidized - expectedSubsidy) < 0.01);
  const expectedRate = (expectedSubsidy / expectedCost) * 100;
  assert.ok(Math.abs(result.subsidyRate - expectedRate) < 0.1);
});

// ── 12. zero tokens → $0 cost ─────────────────────────────────────────────
test('computeSubsidy: zero tokens → $0 cost', () => {
  const entries = [
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 0, output_tokens: 0 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  assert.equal(result.totalCost, 0);
  assert.equal(Object.keys(result.models).length, 0);
});

// ── 13. large token counts → correct math ─────────────────────────────────
test('computeSubsidy: large token counts (no overflow)', () => {
  const entries = [
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 500_000_000, output_tokens: 100_000_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  // input: 500 * $3 = $1500, output: 100 * $15 = $1500
  assert.equal(result.totalCost, 3000);
  assert.ok(Number.isFinite(result.totalCost));
});

// ── 14. date filtering via --since ────────────────────────────────────────
test('runSubsidyCommand: --since filters sessions by mtime', async () => {
  const dir = makeTmpDir();
  try {
    const sessionDir = join(dir, '.claude', 'projects', 'test');
    mkdirSync(sessionDir, { recursive: true });

    // Old session
    const oldFile = join(sessionDir, 'old.jsonl');
    writeFileSync(oldFile, JSON.stringify({ type: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }) + '\n');
    const pastDate = new Date('2020-01-01');
    utimesSync(oldFile, pastDate, pastDate);

    // New session
    const newFile = join(sessionDir, 'new.jsonl');
    writeFileSync(newFile, JSON.stringify({ type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }) + '\n');

    const origHome = process.env.HOME;
    process.env.HOME = dir;
    const origLog = console.log;
    let output = '';
    console.log = (s) => { output += s + '\n'; };
    await runSubsidyCommand('json', { since: '2025-01-01', plan: 'claude-pro' });
    console.log = origLog;
    process.env.HOME = origHome;

    const data = JSON.parse(output.trim());
    assert.equal(data.sessionCount, 1);
    // Should only have sonnet, not opus (old one filtered out)
    assert.ok(data.models['claude-sonnet-4-6']);
    assert.ok(!data.models['claude-opus-4-6']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 15. per-model percentage adds to 100% ─────────────────────────────────
test('computeSubsidy: per-model percentages add to ~100%', () => {
  const entries = [
    { type: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    { type: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    { type: 'assistant', model: 'claude-haiku-3-5', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  const total = result.totalCost;
  let pctSum = 0;
  for (const mc of Object.values(result.models)) {
    pctSum += (mc.cost / total) * 100;
  }
  assert.ok(Math.abs(pctSum - 100) < 0.01, `percentages sum to ${pctSum}, expected ~100`);
});

// ── 16. entry.message.usage fallback ──────────────────────────────────────
test('computeSubsidy: reads usage from entry.message.usage', () => {
  const entries = [
    { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } } },
  ];
  const result = computeSubsidy(entries, 'claude-pro');
  assert.equal(result.totalCost, 18);
});

// ── 17. gpt-4o pricing ───────────────────────────────────────────────────
test('computeSubsidy: gpt-4o pricing', () => {
  const entries = [
    { type: 'assistant', model: 'gpt-4o', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ];
  const result = computeSubsidy(entries, 'chatgpt-plus');
  // input: $2.50 + output: $10 = $12.50
  assert.equal(result.totalCost, 12.5);
  assert.equal(result.subscriptionCost, 20);
});
