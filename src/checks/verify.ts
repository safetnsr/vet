import { join, resolve, basename, dirname } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { CheckResult, Issue } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function isTestFile(filePath: string): boolean {
  const base = basename(filePath);
  if (/\.(test|spec)\.[a-z]+$/i.test(base)) return true;
  const normalized = filePath.replace(/\\/g, '/');
  // Match __tests__/ anywhere in path (including at root)
  if (normalized.includes('__tests__/') || normalized.includes('/__tests__')) return true;
  if (normalized.includes('/test/') || normalized.startsWith('test/')) return true;
  if (normalized.includes('/tests/') || normalized.startsWith('tests/')) return true;
  return false;
}

function hasAssertions(content: string): boolean {
  return /\b(assert|expect\s*\(|it\s*\(|test\s*\(|describe\s*\(|should\.|toBe\(|toEqual\(|assertEqual|assertStrictEqual)\b/i.test(content);
}

function countLines(content: string): number {
  return content.split('\n').filter(l => l.trim().length > 0).length;
}

/** Extract file names mentioned in commit messages as claims */
function extractClaimsFromMessages(messages: string[]): string[] {
  const claims: string[] = [];
  // All patterns require a file extension (dot in name) to avoid false positives
  const patterns = [
    /\b(?:creat\w*|add\w*|implement\w*|wrot\w*|built|generat\w*|scaffold\w*)\s+([\w./\\-]+\.[a-z]{1,5})/gi,
    /\b(?:fix\w*|resolv\w*|updat\w*|modify|modified)\s+([\w./\\-]+\.[a-z]{1,5})/gi,
    /\badd\w*\s+tests?\s+(?:for\s+)?([\w./\\-]+\.[a-z]{1,5})/gi,
  ];
  for (const msg of messages) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(msg)) !== null) {
        const candidate = m[1].replace(/[,.:;)]+$/, '');
        if (candidate && candidate.length > 2 && !candidate.startsWith('-')) {
          claims.push(candidate);
        }
      }
    }
  }
  return [...new Set(claims)];
}

/** Get files changed in recent agent session (git diff against since or HEAD~1) */
function getChangedFiles(cwd: string, since?: string): string[] {
  let raw = '';
  if (since) {
    raw = safeExec(`git diff ${since} --name-only`, cwd);
  } else {
    // Try HEAD~1 first
    raw = safeExec(`git diff HEAD~1 --name-only`, cwd);
    if (!raw.trim()) {
      // Fall back to last commit's added/modified files
      raw = safeExec(`git show --name-only --format="" HEAD`, cwd);
    }
  }
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('diff') && !l.startsWith('index'));
}

/** Get recent git log messages */
function getRecentMessages(cwd: string, since?: string): string[] {
  let raw = '';
  if (since) {
    raw = safeExec(`git log ${since}..HEAD --oneline`, cwd);
  } else {
    raw = safeExec(`git log -10 --oneline`, cwd);
  }
  return raw.split('\n').map(l => l.replace(/^[a-f0-9]+\s+/, '').trim()).filter(l => l.length > 0);
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkVerify(cwd: string, since?: string): CheckResult {
  const issues: Issue[] = [];
  let deductions = 0;

  // Check if git repo
  const isGit = safeExec('git rev-parse --is-inside-work-tree', cwd).trim();
  if (isGit !== 'true') {
    return {
      name: 'verify',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'not a git repository — skipped',
    };
  }

  // Check if any commits exist
  const hasCommits = safeExec('git rev-parse HEAD', cwd).trim();
  if (!hasCommits) {
    return {
      name: 'verify',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no commits found — skipped',
    };
  }

  // Get changed files from git diff
  const changedFiles = getChangedFiles(cwd, since);

  // Get commit messages for claim extraction
  const messages = getRecentMessages(cwd, since);

  // Extract explicit claims from commit messages
  const explicitClaims = extractClaimsFromMessages(messages);

  // Build unified file list to verify: changed files + explicitly claimed files
  const toVerify = new Set<string>();
  for (const f of changedFiles) toVerify.add(f);
  for (const f of explicitClaims) toVerify.add(f);

  if (toVerify.size === 0) {
    return {
      name: 'verify',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no agent claims found in recent git history',
    };
  }

  let verified = 0;
  let failed = 0;

  for (const relPath of toVerify) {
    const absPath = join(cwd, relPath);

    // 1. File must exist
    if (!existsSync(absPath)) {
      // Only flag files that were explicitly in claims from messages (not just diff-referenced)
      // Changed files that don't exist could be deletions — only flag if explicitly claimed
      if (explicitClaims.includes(relPath)) {
        issues.push({
          severity: 'error',
          message: `Claimed file missing: ${relPath}`,
          file: relPath,
          fixable: false,
          fixHint: 'Agent claimed to create this file but it does not exist',
        });
        deductions += 15;
        failed++;
      }
      continue;
    }

    let content = '';
    try {
      const stat = statSync(absPath);
      if (!stat.isFile()) {
        verified++;
        continue;
      }
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lineCount = countLines(content);

    // 2. File must have meaningful content (>10 non-empty lines)
    if (lineCount < 10 && lineCount > 0) {
      issues.push({
        severity: 'warning',
        message: `Thin file: ${relPath} (${lineCount} non-empty lines)`,
        file: relPath,
        fixable: false,
        fixHint: 'Agent claimed to create/modify this file but it has minimal content',
      });
      deductions += 8;
      failed++;
      continue;
    }

    if (lineCount === 0) {
      issues.push({
        severity: 'error',
        message: `Empty file: ${relPath}`,
        file: relPath,
        fixable: false,
        fixHint: 'Agent claimed to create this file but it is empty',
      });
      deductions += 15;
      failed++;
      continue;
    }

    // 3. Test files must have actual assertions
    if (isTestFile(relPath)) {
      if (!hasAssertions(content)) {
        issues.push({
          severity: 'error',
          message: `Test file has no assertions: ${relPath}`,
          file: relPath,
          fixable: false,
          fixHint: 'Test file exists but contains no expect(), assert(), or test() calls',
        });
        deductions += 12;
        failed++;
        continue;
      }
    }

    verified++;
  }

  const finalScore = Math.max(0, 100 - deductions);

  return {
    name: 'verify',
    score: finalScore,
    maxScore: 100,
    issues,
    summary: failed === 0
      ? `${verified} agent claim${verified !== 1 ? 's' : ''} verified clean`
      : `${failed} claim${failed !== 1 ? 's' : ''} failed verification (${verified} passed)`,
  };
}
