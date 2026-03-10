import { join, relative } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { CheckResult, Issue } from '../types.js';
import { cachedReadFile as cachedRead } from '../file-cache.js';

// ── Dangerous patterns in source code ────────────────────────────────────────

interface SourcePattern {
  id: string;
  regex: RegExp;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

const SOURCE_PATTERNS: SourcePattern[] = [
  {
    id: 'eval',
    regex: /\beval\s*\(/,
    severity: 'error',
    message: 'eval() usage — arbitrary code execution risk',
  },
  {
    id: 'exec-sync',
    regex: /\bexecSync\s*\(|\bexecFileSync\s*\(/,
    severity: 'warning',
    message: 'execSync/execFileSync — synchronous shell execution, injection risk if user input flows in',
  },
  {
    id: 'child-process-exec',
    regex: /\brequire\s*\(\s*['"]child_process['"]\s*\)/,
    severity: 'warning',
    message: 'child_process require — verify no untrusted input reaches shell commands',
  },
  {
    id: 'function-constructor',
    regex: /new\s+Function\s*\(/,
    severity: 'error',
    message: 'new Function() — dynamic code generation, equivalent to eval()',
  },
  {
    id: 'innerhtml',
    regex: /\.innerHTML\s*=|dangerouslySetInnerHTML/,
    severity: 'warning',
    message: 'innerHTML/dangerouslySetInnerHTML — XSS risk if content is not sanitized',
  },
  {
    id: 'hardcoded-jwt',
    regex: /['"]eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
    severity: 'error',
    message: 'hardcoded JWT token detected',
  },
  {
    id: 'hardcoded-private-key',
    regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
    severity: 'error',
    message: 'hardcoded private key detected',
  },
  {
    id: 'disable-tls',
    regex: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false/,
    severity: 'error',
    message: 'TLS verification disabled — man-in-the-middle risk',
  },
  {
    id: 'sql-concat',
    regex: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)\s+.*\$\{|(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)\s+.*\+\s*(?:req\.|params\.|query\.|body\.)/i,
    severity: 'error',
    message: 'SQL query string concatenation — SQL injection risk',
  },
];

// ── Source file collection ────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__']);
const MAX_FILES = 500;
const MAX_FILE_SIZE = 512 * 1024; // 512KB

function collectSourceFiles(cwd: string, maxFiles = MAX_FILES): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 8 || files.length >= maxFiles) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (files.length >= maxFiles) break;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
          walk(join(dir, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const ext = entry.name.slice(entry.name.lastIndexOf('.'));
          if (SOURCE_EXTENSIONS.has(ext)) {
            const full = join(dir, entry.name);
            try {
              if (statSync(full).size <= MAX_FILE_SIZE) {
                files.push(full);
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  }

  walk(cwd, 0);
  return files;
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkSourceSecurity(cwd: string): CheckResult {
  const files = collectSourceFiles(cwd);
  const issues: Issue[] = [];

  for (const filePath of files) {
    try {
      const content = cachedRead(filePath);
      if (!content) continue;
      const relPath = relative(cwd, filePath);
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip comments
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

        // Skip test files for some patterns
        const isTest = relPath.includes('.test.') || relPath.includes('.spec.') || relPath.includes('__tests__');

        for (const pattern of SOURCE_PATTERNS) {
          // execSync in util files and non-test is fine for CLI tools — only flag in src/
          if (pattern.id === 'exec-sync' && !relPath.startsWith('src/')) continue;
          // Skip innerHTML in test files
          if (pattern.id === 'innerhtml' && isTest) continue;

          if (pattern.regex.test(line)) {
            pattern.regex.lastIndex = 0;
            issues.push({
              severity: pattern.severity,
              message: pattern.message,
              file: relPath,
              line: i + 1,
              fixable: false,
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const score = Math.max(0, 100 - errors * 30 - warnings * 10);

  return {
    name: 'source-security',
    score,
    maxScore: 100,
    issues,
    summary: files.length === 0
      ? 'no source files found'
      : issues.length === 0
        ? `${files.length} source files scanned, clean`
        : `${issues.length} security finding${issues.length !== 1 ? 's' : ''} in source code`,
  };
}
