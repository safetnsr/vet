import type { CheckResult, Issue } from '../types.js';
import { git } from '../util.js';

interface Pattern {
  regex: RegExp;
  message: string;
  severity: 'error' | 'warning';
}

const PATTERNS: Pattern[] = [
  // Secrets
  { regex: /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*['"][^'"]{8,}['"]/i, message: 'possible hardcoded secret', severity: 'error' },
  { regex: /sk-[a-zA-Z0-9]{20,}/, message: 'possible OpenAI API key', severity: 'error' },
  { regex: /AKIA[0-9A-Z]{16}/, message: 'possible AWS access key', severity: 'error' },
  { regex: /AIza[0-9A-Za-z_-]{35}/, message: 'possible Google API key', severity: 'error' },

  // AI anti-patterns
  { regex: /\/\/\s*TODO[:\s]/i, message: 'TODO comment left in code', severity: 'warning' },
  { regex: /\/\/\s*FIXME[:\s]/i, message: 'FIXME comment left in code', severity: 'warning' },
  { regex: /\/\/\s*HACK[:\s]/i, message: 'HACK comment left in code', severity: 'warning' },
  { regex: /console\.log\(/, message: 'console.log left in code', severity: 'warning' },
  { regex: /catch\s*\([^)]*\)\s*\{\s*\}/, message: 'empty catch block — error silently swallowed', severity: 'error' },
  { regex: /catch\s*\([^)]*\)\s*\{\s*\/\//, message: 'catch block with only a comment — errors need handling', severity: 'warning' },
  { regex: /it\(\s*['"].*['"]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\}\s*\)/, message: 'empty test body — stubbed test', severity: 'error' },
  { regex: /test\(\s*['"].*['"]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\}\s*\)/, message: 'empty test body — stubbed test', severity: 'error' },
  { regex: /expect\(true\)\.toBe\(true\)/, message: 'trivial assertion — test proves nothing', severity: 'error' },
  { regex: /assert\s+True\s*$/, message: 'trivial assertion — test proves nothing', severity: 'error' },
  { regex: /\.only\(/, message: '.only() left in test — other tests will be skipped', severity: 'error' },
  { regex: /debugger;/, message: 'debugger statement left in code', severity: 'error' },
];

export function checkDiff(cwd: string): CheckResult {
  const issues: Issue[] = [];

  // Get staged + unstaged diff
  let diff = git('diff HEAD', cwd);
  if (!diff) diff = git('diff --cached', cwd);
  if (!diff) diff = git('diff', cwd);

  if (!diff) {
    return {
      name: 'diff',
      score: 10,
      maxScore: 10,
      issues: [],
      summary: 'no uncommitted changes to check',
    };
  }

  // Parse diff: only check added lines
  let currentFile = '';
  let lineNum = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) currentFile = match[1];
      lineNum = 0;
      continue;
    }
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) lineNum = parseInt(match[1]) - 1;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNum++;
      const added = line.slice(1);
      for (const pattern of PATTERNS) {
        if (pattern.regex.test(added)) {
          issues.push({
            severity: pattern.severity,
            message: pattern.message,
            file: currentFile,
            line: lineNum,
            fixable: false,
          });
          break; // one issue per line
        }
      }
    } else if (!line.startsWith('-')) {
      lineNum++;
    }
  }

  // Check for deleted error handling
  let deletedErrorHandling = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('-') && !line.startsWith('---')) {
      if (/catch|throw|Error|reject|finally/.test(line)) {
        deletedErrorHandling++;
      }
    }
  }
  if (deletedErrorHandling > 3) {
    issues.push({ severity: 'warning', message: `${deletedErrorHandling} lines of error handling removed — verify this was intentional`, fixable: false });
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const score = Math.max(0, Math.min(10, 10 - errors * 1.5 - warnings * 0.5));

  return {
    name: 'diff',
    score: Math.round(score * 10) / 10,
    maxScore: 10,
    issues,
    summary: issues.length === 0 ? 'clean diff, no issues' : `${issues.length} issues in uncommitted changes`,
  };
}
