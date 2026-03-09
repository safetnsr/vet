import { join, extname, relative } from 'node:path';
import { cachedRead } from '../file-cache.js';
import { walkFiles, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const SCAN_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs', '.sql', '.sh', '.bash', '.py', '.rb']);
const SQL_EXTS = new Set(['.sql', '.ts', '.js', '.mjs', '.cjs']);
const SHELL_EXTS = new Set(['.sh', '.bash', '.ts', '.js']);
const SKIP_DIRS = ['test', '__tests__'];
const SKIP_PATTERN = /\.(test|spec)\.[^.]+$/;

// SQL patterns (case-insensitive)
const DROP_TABLE_RE = /\bDROP\s+TABLE\b/i;
const DROP_DB_RE = /\bDROP\s+DATABASE\b/i;
const TRUNCATE_RE = /\bTRUNCATE\b(\s+TABLE\b)?/i;
const DELETE_FROM_RE = /\bDELETE\s+FROM\b/i;
const DELETE_WHERE_RE = /\bDELETE\s+FROM\b.*\bWHERE\b/i;

// Shell patterns
const RM_RF_RE = /\brm\s+-(r|rf|fr)\b/i;
const RMDIR_RE = /\brmdir\b/i;
const SHRED_RE = /\bshred\b/;
const TRUNCATE_CMD_RE = /\btruncate\s+--size\b/;

// JS exec patterns
const EXEC_CALL_RE = /\b(exec|execSync|spawn|spawnSync)\s*\(/;

// Migration path patterns
const MIGRATION_PATH_RE = /migrat|db[/\\]/i;

// Rollback function patterns
const ROLLBACK_RE = /\b(down|rollback|revert)\s*\(/;

// ── Helpers ──────────────────────────────────────────────────────────────────

function shouldSkip(relPath: string): boolean {
  const parts = relPath.split(/[/\\]/);
  for (const part of parts) {
    if (SKIP_DIRS.includes(part)) return true;
  }
  return SKIP_PATTERN.test(relPath);
}

function scanLine(line: string, lineNum: number, relPath: string, ext: string, issues: Issue[]): void {
  const isSqlExt = SQL_EXTS.has(ext);
  const isShellExt = SHELL_EXTS.has(ext);

  // Pass 1 — SQL patterns
  if (isSqlExt) {
    if (DROP_TABLE_RE.test(line)) {
      issues.push({ severity: 'error', message: 'DROP TABLE without transaction', file: relPath, line: lineNum, fixable: false, fixHint: 'wrap in transaction or add rollback' });
    }
    if (DROP_DB_RE.test(line)) {
      issues.push({ severity: 'error', message: 'DROP DATABASE detected', file: relPath, line: lineNum, fixable: false, fixHint: 'remove or gate behind confirmation' });
    }
    if (TRUNCATE_RE.test(line)) {
      issues.push({ severity: 'error', message: 'TRUNCATE operation detected', file: relPath, line: lineNum, fixable: false, fixHint: 'use soft-delete or add rollback' });
    }
    if (DELETE_FROM_RE.test(line)) {
      if (DELETE_WHERE_RE.test(line)) {
        issues.push({ severity: 'warning', message: 'DELETE FROM with WHERE clause', file: relPath, line: lineNum, fixable: false, fixHint: 'consider soft-delete or add --dry-run check' });
      } else {
        issues.push({ severity: 'error', message: 'DELETE FROM without WHERE clause', file: relPath, line: lineNum, fixable: false, fixHint: 'add WHERE clause or use TRUNCATE with rollback' });
      }
    }
  }

  // Pass 2 — Shell patterns
  if (isShellExt) {
    // Direct shell commands in .sh/.bash
    if (ext === '.sh' || ext === '.bash') {
      if (RM_RF_RE.test(line)) {
        issues.push({ severity: 'error', message: 'rm -rf in shell script', file: relPath, line: lineNum, fixable: false, fixHint: 'use trash-cli or add confirmation gate' });
      }
      if (RMDIR_RE.test(line)) {
        issues.push({ severity: 'error', message: 'rmdir in shell script', file: relPath, line: lineNum, fixable: false, fixHint: 'use trash-cli or add confirmation gate' });
      }
      if (SHRED_RE.test(line)) {
        issues.push({ severity: 'error', message: 'shred command detected', file: relPath, line: lineNum, fixable: false, fixHint: 'remove or gate behind confirmation' });
      }
      if (TRUNCATE_CMD_RE.test(line)) {
        issues.push({ severity: 'error', message: 'truncate --size command detected', file: relPath, line: lineNum, fixable: false, fixHint: 'remove or gate behind confirmation' });
      }
    }

    // JS/TS exec/spawn calls with destructive commands
    if (ext === '.ts' || ext === '.js') {
      if (EXEC_CALL_RE.test(line)) {
        if (RM_RF_RE.test(line)) {
          issues.push({ severity: 'error', message: 'rm -rf in exec call', file: relPath, line: lineNum, fixable: false, fixHint: 'use trash-cli or add confirmation gate' });
        }
        if (RMDIR_RE.test(line)) {
          issues.push({ severity: 'error', message: 'rmdir in exec call', file: relPath, line: lineNum, fixable: false, fixHint: 'use trash-cli or add confirmation gate' });
        }
        if (SHRED_RE.test(line)) {
          issues.push({ severity: 'error', message: 'shred in exec call', file: relPath, line: lineNum, fixable: false, fixHint: 'remove or gate behind confirmation' });
        }
        if (TRUNCATE_CMD_RE.test(line)) {
          issues.push({ severity: 'error', message: 'truncate --size in exec call', file: relPath, line: lineNum, fixable: false, fixHint: 'remove or gate behind confirmation' });
        }
      }
    }
  }
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkGuard(cwd: string): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd);

  for (const relPath of files) {
    const ext = extname(relPath).toLowerCase();

    if (!SCAN_EXTS.has(ext)) continue;
    if (shouldSkip(relPath)) continue;

    const fullPath = join(cwd, relPath);
    let content: string;
    try { content = cachedRead(fullPath); } catch { continue; }

    const rel = relPath;

    const lines = content.split('\n');
    const fileIssuesBefore = issues.length;

    for (let i = 0; i < lines.length; i++) {
      scanLine(lines[i], i + 1, rel, ext, issues);
    }

    // Pass 3 — Migration check
    if (MIGRATION_PATH_RE.test(rel)) {
      const hasDestructive = DROP_TABLE_RE.test(content) || DROP_DB_RE.test(content) ||
        DELETE_FROM_RE.test(content) || TRUNCATE_RE.test(content);
      const hasRollback = ROLLBACK_RE.test(content);

      if (hasDestructive && !hasRollback) {
        issues.push({
          severity: 'warning',
          message: 'migration with destructive operation but no rollback function',
          file: rel,
          fixable: false,
          fixHint: 'add down() or rollback() function',
        });
      }
    }
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const total = errors + warnings;
  const score = Math.max(0, 100 - (errors * 15) - (warnings * 5));
  const summary = total === 0
    ? 'no destructive patterns found'
    : `${total} bomb sites found (${errors} fatal, ${warnings} warning)`;

  return { name: 'guard', score, maxScore: 100, issues, summary };
}

// ── Subcommand output ────────────────────────────────────────────────────────

export async function runGuardCommand(format: string, cwd?: string): Promise<void> {
  const dir = cwd || process.cwd();
  const result = checkGuard(dir);

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`\n  ${c.bold}vet guard${c.reset} — destructive operation scanner\n`);

  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  if (errors.length > 0) {
    console.log(`  ${c.red}FATAL${c.reset}`);
    for (const issue of errors) {
      const loc = issue.file ? (issue.line ? `${issue.file}:${issue.line}` : issue.file) : '';
      console.log(`  ${c.red}✗${c.reset} ${issue.message}${loc ? ` (${loc})` : ''}`);
      if (issue.fixHint) console.log(`    ${c.dim}→ ${issue.fixHint}${c.reset}`);
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`  ${c.yellow}WARN${c.reset}`);
    for (const issue of warnings) {
      const loc = issue.file ? (issue.line ? `${issue.file}:${issue.line}` : issue.file) : '';
      console.log(`  ${c.yellow}⚠${c.reset} ${issue.message}${loc ? ` (${loc})` : ''}`);
      if (issue.fixHint) console.log(`    ${c.dim}→ ${issue.fixHint}${c.reset}`);
    }
    console.log();
  }

  if (result.issues.length === 0) {
    console.log(`  ${c.green}no destructive patterns found${c.reset}\n`);
  }

  console.log(`  ${result.summary}\n`);
}
