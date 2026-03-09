import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { c } from '../util.js';
import { findLatestSession } from './receipt.js';
import type { CheckResult, Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionEntry {
  type?: string;
  role?: string;
  content?: unknown;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: SessionEntry['usage'];
  };
  [key: string]: unknown;
}

interface ToolUseBlock {
  type: 'tool_use';
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

interface Iteration {
  index: number;
  fileChanges: number;
  uniqueFiles: Set<string>;
  testCount: number;
  outcome: 'pass' | 'fail' | 'unknown';
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

// ── Pricing table (per 1M tokens) ────────────────────────────────────────────

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-haiku-3-5': { input: 0.25, output: 1.25 },
};

const FALLBACK_PRICING = { input: 3, output: 15 };

function getPricing(model: string): { input: number; output: number } {
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.includes(key)) return price;
  }
  // Partial match
  if (model.includes('opus')) return { input: 15, output: 75 };
  if (model.includes('haiku')) return { input: 0.25, output: 1.25 };
  return FALLBACK_PRICING;
}

function calcCost(inputTokens: number, outputTokens: number, model: string): number {
  const price = getPricing(model);
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

// ── Test command detection ────────────────────────────────────────────────────

const TEST_PATTERNS = [
  /\bjest\b/,
  /\bvitest\b/,
  /\bpytest\b/,
  /npm\s+test\b/,
  /npm\s+run\s+test\b/,
  /node\s+--test\b/,
  /npx\s+vitest\b/,
  /npx\s+jest\b/,
  /\bmake\s+test\b/,
  /\bcargo\s+test\b/,
];

function isTestCommand(cmd: string): boolean {
  return TEST_PATTERNS.some(p => p.test(cmd));
}

// ── File write detection ──────────────────────────────────────────────────────

function isFileWrite(name: string, input: Record<string, unknown>): { isWrite: boolean; filePath?: string } {
  // Tool name contains str_replace or write
  if (/str_replace|write|edit/i.test(name)) {
    const fp = (input['path'] as string) || (input['file_path'] as string) || undefined;
    return { isWrite: true, filePath: fp };
  }
  // Bash command with redirect
  if (name === 'bash' || name === 'shell') {
    const cmd = (input['command'] as string) || '';
    const hasRedirect = /(?:>>?|tee\s|cat\s*>|sed\s+-i)\s*\S/.test(cmd);
    if (hasRedirect) {
      // Try to extract the target file
      const match = cmd.match(/(?:>>?\s*|tee\s+|cat\s*>\s*)([^\s|;&]+)/);
      return { isWrite: true, filePath: match?.[1] };
    }
  }
  return { isWrite: false };
}

// ── Test outcome extraction ───────────────────────────────────────────────────

function extractTestCount(text: string): number {
  // "12 passing", "12 passed", "12 tests"
  const m = text.match(/(\d+)\s+(?:passing|passed|tests?)/i);
  return m ? parseInt(m[1]!, 10) : 0;
}

function extractOutcome(text: string): 'pass' | 'fail' | 'unknown' {
  const lower = text.toLowerCase();

  // Non-zero explicit failure count wins immediately
  if (/\b[1-9]\d*\s+fail(?:ed|ing|ure)?\b/i.test(text)) return 'fail';

  // FAIL (all-caps marker used by Jest etc.)
  if (/\bFAIL\b/.test(text)) return 'fail';

  // Exit code failure
  if (/exit code [1-9]/i.test(lower)) return 'fail';

  // "0 failing" — explicitly zero failures
  if (/\b0\s+fail(?:ed|ing|ure)?\b/i.test(lower)) return 'pass';

  // Positive pass signals
  if (/\bpassing\b|\bpassed\b/.test(lower)) return 'pass';
  if (/test result:\s*ok\b/i.test(text)) return 'pass';
  if (/all tests passed/i.test(text)) return 'pass';

  // Generic fail words (no count context)
  if (/\b(?:failed|failing|failure)\b/i.test(text)) return 'fail';
  if (/\berror\b/.test(lower)) return 'fail';

  if (/\bpass\b/.test(lower)) return 'pass';
  return 'unknown';
}

// ── Core parsing ─────────────────────────────────────────────────────────────

async function parseEntries(filePath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionEntry);
    } catch { /* skip malformed */ }
  }
  return entries;
}

function getToolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is ToolUseBlock => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_use');
}

function getTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => {
      if (typeof b === 'string') return b;
      if (b && typeof b === 'object') {
        const obj = b as Record<string, unknown>;
        if (typeof obj['text'] === 'string') return obj['text'];
        if (typeof obj['content'] === 'string') return obj['content'];
      }
      return '';
    }).join('\n');
  }
  return '';
}

export function analyzeSession(entries: SessionEntry[]): {
  iterations: Iteration[];
  totalCost: number;
  allFiles: Set<string>;
  model: string;
} {
  let model = 'claude-sonnet-4-6'; // default
  const iterations: Iteration[] = [];

  // Detect model
  for (const entry of entries) {
    if (typeof entry['model'] === 'string' && entry['model']) {
      model = entry['model'];
      break;
    }
    if (entry['message'] && typeof (entry['message'] as Record<string, unknown>)['model'] === 'string') {
      model = (entry['message'] as Record<string, unknown>)['model'] as string;
      break;
    }
  }

  // We segment by test command invocations.
  // Each time we see a test command tool_use, we close the current iteration and start a new one.
  // The iteration collects file writes BEFORE the test command.

  let currentIteration: Iteration = {
    index: 1,
    fileChanges: 0,
    uniqueFiles: new Set(),
    testCount: 0,
    outcome: 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
  let hasStarted = false;
  let pendingTestEntry = false; // next tool_result belongs to a test command
  const allFiles: Set<string> = new Set();

  for (const entry of entries) {
    // Accumulate token usage
    const usage = entry['usage'] || (entry['message'] as Record<string, unknown> | undefined)?.['usage'] as SessionEntry['usage'];
    if (usage) {
      const inp = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const out = usage.output_tokens || 0;
      currentIteration.inputTokens += inp;
      currentIteration.outputTokens += out;
    }

    // Assistant messages with tool_use blocks
    const contentToCheck = entry['content'] || (entry['message'] as Record<string, unknown> | undefined)?.['content'];
    const blocks = getToolUseBlocks(contentToCheck);

    for (const block of blocks) {
      const name = block.name || '';
      const input = block.input || {};
      const cmd = (input['command'] as string) || '';

      // Detect test command
      if ((name === 'bash' || name === 'shell') && isTestCommand(cmd)) {
        if (hasStarted) {
          // Close current iteration
          currentIteration.cost = calcCost(currentIteration.inputTokens, currentIteration.outputTokens, model);
          iterations.push(currentIteration);
          currentIteration = {
            index: iterations.length + 1,
            fileChanges: 0,
            uniqueFiles: new Set(),
            testCount: 0,
            outcome: 'unknown',
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
          };
        }
        hasStarted = true;
        pendingTestEntry = true;
        continue;
      }

      // Detect file writes (only if we've started or not yet — track globally)
      const { isWrite, filePath } = isFileWrite(name, input);
      if (isWrite) {
        currentIteration.fileChanges++;
        if (filePath) {
          currentIteration.uniqueFiles.add(filePath);
          allFiles.add(filePath);
        }
      }
    }

    // Tool results (test outcomes)
    if (pendingTestEntry && (entry['type'] === 'tool_result' || entry['role'] === 'tool')) {
      const text = getTextContent(entry['content']);
      const count = extractTestCount(text);
      if (count > 0) currentIteration.testCount = count;
      currentIteration.outcome = extractOutcome(text);
      pendingTestEntry = false;
    }
  }

  // Finalize last iteration if we started one
  if (hasStarted) {
    currentIteration.cost = calcCost(currentIteration.inputTokens, currentIteration.outputTokens, model);
    iterations.push(currentIteration);
  }

  const totalCost = iterations.reduce((s, it) => s + it.cost, 0);

  return { iterations, totalCost, allFiles, model };
}

// ── Score calculation ─────────────────────────────────────────────────────────

function calculateScore(iterations: Iteration[], totalCost: number, allFiles: Set<string>): {
  score: number;
  issues: Issue[];
  runawayFlags: string[];
} {
  const issues: Issue[] = [];
  const runawayFlags: string[] = [];
  let penalty = 0;

  if (iterations.length > 10) {
    runawayFlags.push(`${iterations.length} iterations (threshold: 10)`);
    penalty += 30;
    issues.push({ severity: 'error', message: `runaway: ${iterations.length} iterations (threshold: 10)`, fixable: false });
  }

  if (totalCost > 1) {
    runawayFlags.push(`$${totalCost.toFixed(2)} total cost (threshold: $1.00)`);
    penalty += 20;
    issues.push({ severity: 'error', message: `runaway: $${totalCost.toFixed(2)} total cost (threshold: $1.00)`, fixable: false });
  }

  if (allFiles.size > 20) {
    runawayFlags.push(`${allFiles.size} unique files touched (threshold: 20)`);
    penalty += 10;
    issues.push({ severity: 'warning', message: `runaway: ${allFiles.size} unique files touched (threshold: 20)`, fixable: false });
  }

  for (const it of iterations) {
    if (it.fileChanges > 5) {
      penalty += 5;
      issues.push({ severity: 'warning', message: `iteration ${it.index}: ${it.fileChanges} file changes (threshold: 5)`, fixable: false });
    }
  }

  const score = Math.max(0, 100 - penalty);
  return { score, issues, runawayFlags };
}

// ── Check function (for full vet run) ────────────────────────────────────────

export async function checkLoop(cwd: string): Promise<CheckResult> {
  const sessionFile = findLatestSession();

  if (!sessionFile) {
    return {
      name: 'loop',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no claude session files found (~/.claude/projects/)', fixable: false }],
      summary: 'no session logs found',
    };
  }

  let entries: SessionEntry[];
  try {
    entries = await parseEntries(sessionFile);
  } catch {
    return {
      name: 'loop',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'warning', message: 'could not parse session file', fixable: false }],
      summary: 'session parse error',
    };
  }

  if (entries.length === 0) {
    return {
      name: 'loop',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'session file is empty', fixable: false }],
      summary: 'empty session file',
    };
  }

  const { iterations, totalCost, allFiles } = analyzeSession(entries);

  if (iterations.length === 0) {
    return {
      name: 'loop',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no /loop iterations detected (no test commands found)', fixable: false }],
      summary: 'no loop iterations detected',
    };
  }

  const { score, issues, runawayFlags } = calculateScore(iterations, totalCost, allFiles);

  const failCount = iterations.filter(it => it.outcome === 'fail').length;
  const passCount = iterations.filter(it => it.outcome === 'pass').length;

  return {
    name: 'loop',
    score,
    maxScore: 100,
    issues,
    summary: `${iterations.length} iteration${iterations.length !== 1 ? 's' : ''}: ${passCount} pass, ${failCount} fail${runawayFlags.length > 0 ? ` — runaway: ${runawayFlags.join(', ')}` : ''}`,
  };
}

// ── Standalone subcommand ─────────────────────────────────────────────────────

export async function runLoopCommand(format: 'ascii' | 'json', sessionPath?: string): Promise<void> {
  const filePath = sessionPath || findLatestSession();
  if (!filePath) {
    console.error('no claude session files found in ~/.claude/projects/');
    process.exit(1);
  }

  if (!fs.existsSync(filePath) && !sessionPath) {
    console.error('session file not found');
    process.exit(1);
  }

  const entries = await parseEntries(filePath);
  const { iterations, totalCost, allFiles } = analyzeSession(entries);
  const { score, issues, runawayFlags } = calculateScore(iterations, totalCost, allFiles);

  if (format === 'json') {
    const result: CheckResult = {
      name: 'loop',
      score,
      maxScore: 100,
      issues,
      summary: iterations.length === 0
        ? 'no loop iterations detected'
        : `${iterations.length} iteration${iterations.length !== 1 ? 's' : ''} found`,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ASCII output
  const sessionId = path.basename(filePath, '.jsonl').slice(0, 40);
  console.log(`\n  ${c.bold}vet loop${c.reset} — /loop session forensics\n`);
  console.log(`  session: ${sessionId}`);
  console.log(`  iterations: ${iterations.length}`);
  console.log(`  total cost: $${totalCost.toFixed(2)}\n`);

  if (iterations.length === 0) {
    console.log(`  ${c.green}no /loop iterations detected${c.reset}\n`);
    console.log(`  score: 100/100\n`);
    return;
  }

  // Table header
  const colW = { num: 3, files: 6, tests: 6, outcome: 8, cost: 8 };
  const header = [
    '#'.padEnd(colW.num),
    'files'.padEnd(colW.files),
    'tests'.padEnd(colW.tests),
    'outcome'.padEnd(colW.outcome),
    'cost',
  ].join('  ');
  console.log(`  ${c.dim}${header}${c.reset}`);

  for (const it of iterations) {
    const outcomeStr = it.outcome === 'pass'
      ? `${c.green}pass${c.reset}`
      : it.outcome === 'fail'
        ? `${c.red}fail${c.reset}`
        : `${c.dim}?${c.reset}`;
    const numStr = String(it.index).padEnd(colW.num);
    const filesStr = String(it.fileChanges).padEnd(colW.files);
    const testsStr = String(it.testCount || '-').padEnd(colW.tests);
    const costStr = `$${it.cost.toFixed(2)}`;
    // outcome padding needs to account for color codes (invisible)
    const outcomePadded = outcomeStr + ' '.repeat(Math.max(0, colW.outcome - it.outcome.length));
    console.log(`  ${numStr}  ${filesStr}  ${testsStr}  ${outcomePadded}  ${costStr}`);
  }

  console.log('');

  for (const flag of runawayFlags) {
    console.log(`  ${c.yellow}⚠ runaway: ${flag}${c.reset}`);
  }

  if (runawayFlags.length > 0) console.log('');

  console.log(`  score: ${score}/100\n`);
}
