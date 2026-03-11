import { extname } from 'node:path';
import { gitExec, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SECURITY_PATH_RE = /auth|middleware|permission|secret|crypt|jwt|session|cors|password|login|token/i;
const SECURITY_SKIP_EXTS = new Set(['.css', '.md', '.json', '.svg', '.png']);

const SCHEMA_PATH_RE = /migration|schema|model|entity|prisma|knex|sequelize|drizzle/i;

const ERROR_HANDLER_RE = /try\s*\{|\.catch\(|}\s*catch|catch\s*\(/;

const TEST_PATH_RE = /test|spec|__tests__/;

const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*|#)/;
const WHITESPACE_ONLY_RE = /^\s*$/;

// ── Types ────────────────────────────────────────────────────────────────────

export type TriageRank = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'SKIP';

export interface TriageEntry {
  file: string;
  rank: TriageRank;
  reason: string;
  signals: string[];
  estimateMin: number;
}

// ── Diff parsing ─────────────────────────────────────────────────────────────

interface FileDiff {
  file: string;
  added: number;
  removed: number;
  removedLines: string[];
  addedLines: string[];
  allChangedLines: string[];
}

function parseStatLine(line: string): { file: string; added: number; removed: number } | null {
  // Format: " src/foo.ts | 12 +++---"  or  " src/foo.ts | Bin 0 -> 1234 bytes"
  const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
  if (!match) return null;
  const file = match[1].trim();
  const total = parseInt(match[2], 10);
  // Count + and - chars at end of line for approximation
  const plusMinus = line.match(/\|\s*\d+\s*([+\-]+)\s*$/);
  if (!plusMinus) return { file, added: 0, removed: 0 };
  const symbols = plusMinus[1];
  const added = (symbols.match(/\+/g) || []).length;
  const removed = (symbols.match(/-/g) || []).length;
  // Scale up: the stat line shows proportional +/- not exact counts
  // We'll use the full diff to get exact counts — this is just for file list
  return { file, added, removed };
}

function parseDiff(diffOutput: string): Map<string, FileDiff> {
  const result = new Map<string, FileDiff>();
  if (!diffOutput.trim()) return result;

  const fileDiffs = diffOutput.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');
    const headerMatch = lines[0]?.match(/a\/.+? b\/(.+)/);
    if (!headerMatch) continue;
    const file = headerMatch[1].trim();

    const removedLines: string[] = [];
    const addedLines: string[] = [];
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (!inHunk) continue;
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-')) {
        removedLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        addedLines.push(line.slice(1));
      }
    }

    result.set(file, {
      file,
      added: addedLines.length,
      removed: removedLines.length,
      removedLines,
      addedLines,
      allChangedLines: [...removedLines, ...addedLines],
    });
  }

  return result;
}

// ── Signal detection ─────────────────────────────────────────────────────────

function isSecurityPath(file: string): boolean {
  const ext = extname(file).toLowerCase();
  if (SECURITY_SKIP_EXTS.has(ext)) return false;
  return SECURITY_PATH_RE.test(file);
}

function hasErrorHandlerRemoval(fileDiff: FileDiff): boolean {
  return fileDiff.removedLines.some(line => ERROR_HANDLER_RE.test(line));
}

function isSchemaPath(file: string): boolean {
  return SCHEMA_PATH_RE.test(file);
}

function isCosmetic(fileDiff: FileDiff): boolean {
  const totalChanged = fileDiff.added + fileDiff.removed;
  if (totalChanged < 5) return true;
  // All changed lines are comments or whitespace
  const allCommentOrWhitespace = fileDiff.allChangedLines.every(
    line => WHITESPACE_ONLY_RE.test(line) || COMMENT_LINE_RE.test(line)
  );
  return allCommentOrWhitespace;
}

function isLargeChange(fileDiff: FileDiff, testFilesChanged: boolean): boolean {
  return fileDiff.added >= 50 && !testFilesChanged;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

function rankFile(file: string, fileDiff: FileDiff, anyTestChanged: boolean): TriageEntry {
  const sig1 = isSecurityPath(file);
  const sig2 = hasErrorHandlerRemoval(fileDiff);
  const sig3 = isSchemaPath(file);
  const sig4 = isCosmetic(fileDiff);
  const sig5 = isLargeChange(fileDiff, anyTestChanged);

  const signals: string[] = [];
  if (sig1) signals.push('security path');
  if (sig2) signals.push('error handler removed');
  if (sig3) signals.push('schema/db path');
  if (sig5) signals.push(`${fileDiff.added} lines added, no tests changed`);

  // CRITICAL: sig1 AND (sig2 OR sig3)
  if (sig1 && (sig2 || sig3)) {
    const reasonParts: string[] = ['security path'];
    if (sig2) reasonParts.push('error handler removed');
    if (sig3) reasonParts.push('schema change');
    return { file, rank: 'CRITICAL', reason: reasonParts.join(' + '), signals, estimateMin: 5 };
  }

  // HIGH: sig1 OR sig2 OR sig3
  if (sig1) return { file, rank: 'HIGH', reason: 'security-relevant path', signals, estimateMin: 2 };
  if (sig2) return { file, rank: 'HIGH', reason: 'error handler removed', signals, estimateMin: 2 };
  if (sig3) return { file, rank: 'HIGH', reason: 'schema/db path', signals, estimateMin: 2 };

  // MEDIUM: sig5
  if (sig5) {
    return {
      file,
      rank: 'MEDIUM',
      reason: `${fileDiff.added} lines added, no tests changed`,
      signals,
      estimateMin: 1,
    };
  }

  // SKIP: sig4 or no signals
  const skipReason = sig4 ? 'cosmetic' : 'no signals';
  return { file, rank: 'SKIP', reason: skipReason, signals: [], estimateMin: 0 };
}

// ── Core logic ───────────────────────────────────────────────────────────────

export function analyzeTriage(cwd: string, since = 'HEAD~1'): TriageEntry[] {
  const statOutput = gitExec(['diff', '--stat', since], cwd);
  const diffOutput = gitExec(['diff', since], cwd);

  if (!statOutput && !diffOutput) return [];

  // Parse full diff for per-file line data
  const fileDiffs = parseDiff(diffOutput);

  // Get file list from stat (in case diff missed any)
  const statFiles: string[] = [];
  for (const line of statOutput.split('\n')) {
    const parsed = parseStatLine(line);
    if (parsed) statFiles.push(parsed.file);
  }

  // Union of files from stat and diff
  const allFiles = new Set([...statFiles, ...fileDiffs.keys()]);
  if (allFiles.size === 0) return [];

  // Determine if any test file changed
  const anyTestChanged = [...allFiles].some(f => TEST_PATH_RE.test(f));

  const entries: TriageEntry[] = [];
  for (const file of allFiles) {
    const fd = fileDiffs.get(file) ?? {
      file,
      added: 0,
      removed: 0,
      removedLines: [],
      addedLines: [],
      allChangedLines: [],
    };
    entries.push(rankFile(file, fd, anyTestChanged));
  }

  // Sort: CRITICAL first, then HIGH, MEDIUM, SKIP
  const rankOrder: Record<TriageRank, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, SKIP: 3 };
  entries.sort((a, b) => rankOrder[a.rank] - rankOrder[b.rank]);

  return entries;
}

// ── CheckResult integration ──────────────────────────────────────────────────

export function checkTriage(cwd: string, since?: string): CheckResult {
  const entries = analyzeTriage(cwd, since ?? 'HEAD~1');
  const issues: Issue[] = [];

  for (const entry of entries) {
    if (entry.rank === 'SKIP') continue;
    const severity = entry.rank === 'CRITICAL' ? 'error' : entry.rank === 'HIGH' ? 'warning' : 'info';
    issues.push({
      severity,
      message: `[${entry.rank}] ${entry.file} — ${entry.reason}`,
      file: entry.file,
      fixable: false,
      fixHint: `review ${entry.file} (~${entry.estimateMin} min)`,
    });
  }

  const critical = entries.filter(e => e.rank === 'CRITICAL').length;
  const high = entries.filter(e => e.rank === 'HIGH').length;
  const medium = entries.filter(e => e.rank === 'MEDIUM').length;
  const skip = entries.filter(e => e.rank === 'SKIP').length;
  const totalMin = entries.reduce((sum, e) => sum + e.estimateMin, 0);

  const score = critical > 0 ? Math.max(0, 100 - critical * 25 - high * 10 - medium * 5)
    : high > 0 ? Math.max(0, 100 - high * 10 - medium * 5)
    : Math.max(0, 100 - medium * 5);

  const summary = entries.length === 0
    ? 'no diff to analyze'
    : `${entries.length} files changed — ${critical} critical, ${high} high, ${medium} medium, ${skip} skip (~${totalMin} min)`;

  return { name: 'triage', score, maxScore: 100, issues, summary };
}

// ── Subcommand output ────────────────────────────────────────────────────────

export async function runTriageCommand(format: string, cwd?: string, since?: string): Promise<void> {
  const dir = cwd || process.cwd();
  const sinceRef = since ?? 'HEAD~1';
  const entries = analyzeTriage(dir, sinceRef);

  if (format === 'json') {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log(`\n  ${c.bold}vet triage${c.reset} — diff review urgency\n`);

  if (entries.length === 0) {
    console.log(`  ${c.dim}no diff to analyze${c.reset}\n`);
    return;
  }

  const critical = entries.filter(e => e.rank === 'CRITICAL');
  const high = entries.filter(e => e.rank === 'HIGH');
  const medium = entries.filter(e => e.rank === 'MEDIUM');
  const skip = entries.filter(e => e.rank === 'SKIP');

  if (critical.length > 0) {
    console.log(`  ${c.red}${c.bold}CRITICAL${c.reset}  ${c.dim}(est. 5 min each)${c.reset}`);
    for (const e of critical) {
      console.log(`  ${c.red}✗${c.reset} ${e.file}  ${c.dim}— ${e.reason}${c.reset}`);
    }
    console.log();
  }

  if (high.length > 0) {
    console.log(`  ${c.yellow}${c.bold}HIGH${c.reset}  ${c.dim}(est. 2 min each)${c.reset}`);
    for (const e of high) {
      console.log(`  ${c.yellow}⚠${c.reset} ${e.file}  ${c.dim}— ${e.reason}${c.reset}`);
    }
    console.log();
  }

  if (medium.length > 0) {
    console.log(`  ${c.green}${c.bold}MEDIUM${c.reset}  ${c.dim}(est. 1 min each)${c.reset}`);
    for (const e of medium) {
      console.log(`  ${c.green}○${c.reset} ${e.file}  ${c.dim}— ${e.reason}${c.reset}`);
    }
    console.log();
  }

  if (skip.length > 0) {
    console.log(`  ${c.dim}SKIP  (${skip.length} file${skip.length !== 1 ? 's' : ''})${c.reset}`);
    const shown = skip.slice(0, 3);
    const rest = skip.length - shown.length;
    for (const e of shown) {
      console.log(`  ${c.dim}· ${e.file}  — ${e.reason}${c.reset}`);
    }
    if (rest > 0) {
      console.log(`  ${c.dim}· ... and ${rest} more${c.reset}`);
    }
    console.log();
  }

  const reviewCount = critical.length + high.length + medium.length;
  const totalMin = entries.reduce((sum, e) => sum + e.estimateMin, 0);
  console.log(`  ${c.dim}summary: ${entries.length} files changed. review ${reviewCount} files (~${totalMin} min). skip ${skip.length}.${c.reset}\n`);
}
