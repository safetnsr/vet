import type { CheckResult, Issue, DiffOptions } from '../types.js';
import { git, readFile } from '../util.js';
import { join } from 'node:path';

function fileHasVetIgnore(cwd: string, filePath: string, checkName: string): boolean {
  const content = readFile(join(cwd, filePath));
  if (!content) return false;
  const lines = content.split('\n').slice(0, 5);
  const re = new RegExp(`(?://|/\\*|#)\\s*vet-ignore:\\s*${checkName}\\b`);
  return lines.some(l => re.test(l));
}

interface Pattern {
  regex: RegExp;
  message: string;
  severity: 'error' | 'warning';
}

// Generic patterns (still useful but not the star)
const GENERIC_PATTERNS: Pattern[] = [
  // Secrets
  { regex: /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*['"][^'"]{8,}['"]/i, message: 'possible hardcoded secret', severity: 'error' },
  { regex: /sk-[a-zA-Z0-9]{20,}/, message: 'possible OpenAI API key', severity: 'error' },
  { regex: /AKIA[0-9A-Z]{16}/, message: 'possible AWS access key', severity: 'error' },
  { regex: /AIza[0-9A-Za-z_-]{35}/, message: 'possible Google API key', severity: 'error' },
  { regex: /debugger;/, message: 'debugger statement', severity: 'error' },
  { regex: /\.only\(/, message: '.only() left in test — other tests skipped', severity: 'error' },
];

// AI-specific patterns — things AI agents do that humans typically don't
const AI_PATTERNS: Pattern[] = [
  // Empty/trivial tests
  { regex: /(?:it|test)\(\s*['"].*['"]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\}\s*\)/, message: '[ai] empty test body — stubbed test', severity: 'error' },
  { regex: /expect\(true\)\.toBe\(true\)/, message: '[ai] trivial assertion — test proves nothing', severity: 'error' },
  { regex: /assert\s+True\s*$/, message: '[ai] trivial assertion', severity: 'error' },

  // Catch-all error handling (AI defaults to generic catches)
  { regex: /catch\s*\([^)]*\)\s*\{\s*\}/, message: '[ai] empty catch block — error silently swallowed', severity: 'error' },
  { regex: /catch\s*\(\w+\)\s*\{\s*console\.(log|error)\(\w+\)\s*;?\s*\}/, message: '[ai] catch-all with just console.log — handle errors specifically', severity: 'warning' },

  // Over-commenting (AI tends to add obvious comments)
  { regex: /\/\/\s*(set|get|return|create|initialize|import|export|define)\s+(the|a)\s+/i, message: '[ai] obvious comment — "// get the value" adds no information', severity: 'warning' },
];

function getDiff(cwd: string, opts: DiffOptions): string {
  if (opts.since) {
    return git(`diff ${opts.since}`, cwd);
  }
  // Default: last commit + working changes
  let diff = git('diff HEAD', cwd);
  if (!diff) diff = git('diff --cached', cwd);
  if (!diff) diff = git('diff', cwd);
  // If still nothing, diff last commit against its parent
  if (!diff) diff = git('diff HEAD~1..HEAD', cwd);
  return diff;
}

interface DiffFile {
  path: string;
  addedLines: { num: number; text: string }[];
  removedLines: string[];
  addedCount: number;
  removedCount: number;
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let lineNum = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) {
        current = { path: match[1], addedLines: [], removedLines: [], addedCount: 0, removedCount: 0 };
        files.push(current);
      }
      lineNum = 0;
      continue;
    }
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) lineNum = parseInt(match[1]) - 1;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNum++;
      current.addedLines.push({ num: lineNum, text: line.slice(1) });
      current.addedCount++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedLines.push(line.slice(1));
      current.removedCount++;
    } else {
      lineNum++;
    }
  }
  return files;
}

export function checkDiff(cwd: string, opts: DiffOptions = {}): CheckResult {
  const issues: Issue[] = [];
  const diff = getDiff(cwd, opts);

  if (!diff) {
    return { name: 'diff', score: 100, maxScore: 100, issues: [], summary: 'no changes to check' };
  }

  const files = parseDiff(diff);
  const allPatterns = [...GENERIC_PATTERNS, ...AI_PATTERNS];

  // Pattern matching on added lines
  for (const file of files) {
    if (fileHasVetIgnore(cwd, file.path, 'diff')) continue;
    for (const { num, text } of file.addedLines) {
      for (const pattern of allPatterns) {
        if (pattern.regex.test(text)) {
          issues.push({ severity: pattern.severity, message: pattern.message, file: file.path, line: num, fixable: false });
          break;
        }
      }
    }
  }

  // AI-specific: wholesale function rewrite detection
  for (const file of files) {
    if (file.removedCount > 10 && file.addedCount > 10) {
      const ratio = Math.min(file.removedCount, file.addedCount) / Math.max(file.removedCount, file.addedCount);
      if (ratio > 0.7 && file.removedCount > 20) {
        issues.push({
          severity: 'warning',
          message: `[ai] ${file.path}: ${file.removedCount} lines removed, ${file.addedCount} added — looks like a wholesale rewrite, verify intent`,
          file: file.path,
          fixable: false,
        });
      }
    }
  }

  // AI-specific: orphaned imports (added import lines without corresponding usage)
  for (const file of files) {
    const addedImports = file.addedLines.filter(l =>
      /^import\s/.test(l.text) || /^from\s/.test(l.text) || /require\(/.test(l.text)
    );
    for (const imp of addedImports) {
      // Extract imported name
      const nameMatch = imp.text.match(/import\s+(?:\{([^}]+)\}|(\w+))/);
      if (nameMatch) {
        const names = (nameMatch[1] || nameMatch[2] || '').split(',').map(n => n.trim().replace(/^type\s+/, '').split(' as ').pop()?.trim()).filter(Boolean);
        for (const name of names) {
          if (!name || name.length < 2) continue;
          // Check if name is used in any other added line OR in unchanged file content
          const usedInAdded = file.addedLines.some(l => l !== imp && l.text.includes(name));
          // Also read the full file to check if name is used in existing (unchanged) code
          const fullContent = readFile(join(cwd, file.path));
          const usedInFile = fullContent ? fullContent.split('\n').some((l, idx) => {
            // Skip the import line itself
            if (l.trim() === imp.text.trim()) return false;
            return l.includes(name);
          }) : false;
          if (!usedInAdded && !usedInFile && file.addedLines.length > 3) {
            issues.push({
              severity: 'warning',
              message: `[ai] imported "${name}" but never used in new code`,
              file: file.path,
              line: imp.num,
              fixable: false,
            });
            break; // one per import line
          }
        }
      }
    }
  }

  // AI-specific: comment density spike
  for (const file of files) {
    if (file.addedCount < 10) continue;
    const commentLines = file.addedLines.filter(l => /^\s*(\/\/|#|\/\*|\*)/.test(l.text)).length;
    const ratio = commentLines / file.addedCount;
    if (ratio > 0.4 && commentLines > 5) {
      issues.push({
        severity: 'info',
        message: `[ai] ${file.path}: ${Math.round(ratio * 100)}% of new lines are comments — AI tends to over-comment`,
        file: file.path,
        fixable: false,
      });
    }
  }

  // Deleted error handling
  let deletedErrorHandling = 0;
  for (const file of files) {
    for (const line of file.removedLines) {
      if (/catch|throw new|\.reject\(|finally\s*\{/.test(line)) deletedErrorHandling++;
    }
  }
  if (deletedErrorHandling > 3) {
    issues.push({ severity: 'warning', message: `${deletedErrorHandling} lines of error handling removed — verify intentional`, fixable: false });
  }

  // Recalibrated scoring
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const score = Math.max(0, Math.min(100, 100 - errors * 20 - warnings * 7.5));

  const aiIssues = issues.filter(i => i.message.startsWith('[ai]')).length;
  const totalFiles = files.length;

  return {
    name: 'diff',
    score: Math.round(score),
    maxScore: 100,
    issues,
    summary: issues.length === 0
      ? `${totalFiles} file${totalFiles !== 1 ? 's' : ''} changed, clean`
      : `${issues.length} issues (${aiIssues} AI-specific) in ${totalFiles} files`,
  };
}
