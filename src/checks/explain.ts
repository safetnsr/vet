import { execSync } from 'node:child_process';
import { c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Risk tier classification ─────────────────────────────────────────────────

export type RiskTier = 'RISKY' | 'REVIEW' | 'SAFE';

interface FileRisk {
  file: string;
  tier: RiskTier;
  reason: string;
}

const RISKY_PATTERNS = [
  /^auth/i, /^session/i, /^payment/i, /^billing/i, /^credential/i,
  /^token/i, /^jwt/i, /^password/i, /^secret/i, /^env/i,
];

const RISKY_PATH_PATTERNS = [
  /config\/prod/i, /migrations\//i, /\.env/i,
];

const REVIEW_PATH_PATTERNS = [
  /^api\//i, /^routes\//i, /^middleware\//i, /^db\//i,
  /^schema/i, /^hooks\//i, /^controllers\//i,
];

const RISKY_REMOVED_KEYWORDS = ['DELETE', 'DROP', 'destroy', 'removeAll', 'truncate', 'rm -rf', 'unlink'];
const REVIEW_ADDED_KEYWORDS = ['TODO', 'FIXME', 'HACK'];

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1];
}

export function classifyFile(filePath: string): { tier: RiskTier; reason: string } {
  const base = basename(filePath).toLowerCase();
  const lower = filePath.toLowerCase();

  for (const pat of RISKY_PATTERNS) {
    if (pat.test(base)) return { tier: 'RISKY', reason: `basename matches ${pat.source}` };
  }

  for (const pat of RISKY_PATH_PATTERNS) {
    if (pat.test(lower)) return { tier: 'RISKY', reason: `path matches ${pat.source}` };
  }

  for (const pat of REVIEW_PATH_PATTERNS) {
    if (pat.test(lower)) return { tier: 'REVIEW', reason: `path matches ${pat.source}` };
  }

  return { tier: 'SAFE', reason: 'no risk patterns matched' };
}

function gitCmd(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function getChangedFiles(cwd: string, since?: string): string[] {
  // Try git diff first
  const ref = since || 'HEAD~1';
  const nameStatus = gitCmd(`diff ${ref} --name-status`, cwd);

  if (nameStatus) {
    return nameStatus.split('\n')
      .filter(l => l.trim())
      .map(l => l.split('\t').slice(1).pop()!)
      .filter(Boolean);
  }

  // Fallback: git status for repos with no history
  const status = gitCmd('status --porcelain', cwd);
  if (status) {
    return status.split('\n')
      .filter(l => l.trim())
      .map(l => l.trim().replace(/^[A-Z?!]+\s+/, ''))
      .filter(Boolean);
  }

  return [];
}

function getHunkKeywords(cwd: string, since?: string): { riskyFiles: Set<string>; reviewFiles: Set<string> } {
  const ref = since || 'HEAD~1';
  const riskyFiles = new Set<string>();
  const reviewFiles = new Set<string>();

  const diff = gitCmd(`diff ${ref} -U0`, cwd);
  if (!diff) return { riskyFiles, reviewFiles };

  let currentFile = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) currentFile = match[1];
      continue;
    }

    // Removed lines (start with - but not ---)
    if (line.startsWith('-') && !line.startsWith('---')) {
      for (const kw of RISKY_REMOVED_KEYWORDS) {
        if (line.includes(kw)) {
          riskyFiles.add(currentFile);
          break;
        }
      }
    }

    // Added lines (start with + but not +++)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      for (const kw of REVIEW_ADDED_KEYWORDS) {
        if (line.includes(kw)) {
          reviewFiles.add(currentFile);
          break;
        }
      }
    }
  }

  return { riskyFiles, reviewFiles };
}

export function analyzeFiles(cwd: string, since?: string): FileRisk[] {
  const files = getChangedFiles(cwd, since);
  if (files.length === 0) return [];

  const { riskyFiles, reviewFiles } = getHunkKeywords(cwd, since);
  const results: FileRisk[] = [];

  for (const file of files) {
    let { tier, reason } = classifyFile(file);

    // Hunk-based bumps
    if (riskyFiles.has(file) && tier !== 'RISKY') {
      tier = 'RISKY';
      reason = 'destructive keyword in removed line';
    } else if (reviewFiles.has(file) && tier === 'SAFE') {
      tier = 'REVIEW';
      reason = 'TODO/FIXME/HACK in added line';
    }

    results.push({ file, tier, reason });
  }

  return results;
}

// ── checkExplain (for full scan integration) ─────────────────────────────────

export function checkExplain(cwd: string, since?: string): CheckResult {
  const files = analyzeFiles(cwd, since);
  const risky = files.filter(f => f.tier === 'RISKY');
  const review = files.filter(f => f.tier === 'REVIEW');

  const rawScore = 100 - (risky.length * 15) - (review.length * 5);
  const finalScore = Math.max(0, Math.min(100, rawScore));

  const issues: Issue[] = [];

  for (const f of risky) {
    issues.push({
      severity: 'error',
      message: `RISKY: ${f.file} — ${f.reason}`,
      file: f.file,
      fixable: false,
    });
  }

  for (const f of review) {
    issues.push({
      severity: 'warning',
      message: `REVIEW: ${f.file} — ${f.reason}`,
      file: f.file,
      fixable: false,
    });
  }

  return {
    name: 'explain',
    score: finalScore,
    maxScore: 100,
    issues,
    summary: `${risky.length} risky, ${review.length} review, ${files.length - risky.length - review.length} safe`,
  };
}

// ── runExplainCommand (standalone CLI) ───────────────────────────────────────

export async function runExplainCommand(
  format: 'json' | 'ascii',
  cwd: string,
  since?: string,
  useAI?: boolean,
  verbose?: boolean,
): Promise<void> {
  if (useAI) {
    console.log(`\n  ${c.dim}LLM classification coming in v2${c.reset}\n`);
    return;
  }

  const files = analyzeFiles(cwd, since);
  const risky = files.filter(f => f.tier === 'RISKY');
  const review = files.filter(f => f.tier === 'REVIEW');
  const safe = files.filter(f => f.tier === 'SAFE');

  if (format === 'json') {
    const output = {
      risky: risky.map(f => ({ file: f.file, reason: f.reason })),
      review: review.map(f => ({ file: f.file, reason: f.reason })),
      safe: safe.map(f => ({ file: f.file, reason: f.reason })),
      summary: {
        risky: risky.length,
        review: review.length,
        safe: safe.length,
        total: files.length,
      },
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ASCII output
  console.log(`\n  ${c.bold}vet explain${c.reset} — risk-tier analysis\n`);

  if (files.length === 0) {
    console.log(`  ${c.dim}no changed files found${c.reset}\n`);
    return;
  }

  if (risky.length > 0) {
    console.log(`  ${c.red}${c.bold}RISKY${c.reset} ${c.dim}(${risky.length})${c.reset}`);
    for (const f of risky) {
      console.log(`  ${c.red}✗${c.reset} ${f.file} ${c.dim}— ${f.reason}${c.reset}`);
    }
    console.log('');
  }

  if (review.length > 0) {
    console.log(`  ${c.yellow}${c.bold}REVIEW${c.reset} ${c.dim}(${review.length})${c.reset}`);
    for (const f of review) {
      console.log(`  ${c.yellow}⚠${c.reset} ${f.file} ${c.dim}— ${f.reason}${c.reset}`);
    }
    console.log('');
  }

  if (verbose && safe.length > 0) {
    console.log(`  ${c.green}${c.bold}SAFE${c.reset} ${c.dim}(${safe.length})${c.reset}`);
    for (const f of safe) {
      console.log(`  ${c.green}✓${c.reset} ${f.file}`);
    }
    console.log('');
  }

  const total = files.length;
  console.log(`  ${c.dim}total: ${total} files — ${risky.length} risky, ${review.length} review, ${safe.length} safe${c.reset}\n`);
}
