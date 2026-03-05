import { join, resolve, dirname, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { walkFiles, readFile } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Hallucinated imports ─────────────────────────────────────────────────────

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.json'];

function resolveRelativeImport(importPath: string, fromFile: string, cwd: string): boolean {
  // fromFile is relative to cwd
  const fromDir = dirname(join(cwd, fromFile));
  const base = resolve(fromDir, importPath);

  // Try as-is
  if (existsSync(base)) return true;

  // Try with extensions appended
  for (const ext of RESOLVE_EXTS) {
    if (existsSync(base + ext)) return true;
  }

  // Try as directory with index
  for (const ext of RESOLVE_EXTS) {
    if (existsSync(join(base, 'index' + ext))) return true;
  }

  // Handle ESM TypeScript pattern: ./foo.js → ./foo.ts (strip .js, try .ts/.tsx etc)
  const baseExt = extname(base);
  if (baseExt) {
    const withoutExt = base.slice(0, -baseExt.length);
    for (const ext of RESOLVE_EXTS) {
      if (existsSync(withoutExt + ext)) return true;
    }
    // Also try as directory index
    for (const ext of RESOLVE_EXTS) {
      if (existsSync(join(withoutExt, 'index' + ext))) return true;
    }
  }

  return false;
}

function extractRelativeImports(source: string): { path: string; line: number }[] {
  const imports: { path: string; line: number }[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // import ... from './foo' or '../bar'
    const fromMatch = line.match(/from\s+['"](\.[^'"]+)['"]/);
    if (fromMatch) {
      imports.push({ path: fromMatch[1], line: i + 1 });
    }
    // require('./foo')
    const reqMatch = line.match(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/);
    if (reqMatch) {
      imports.push({ path: reqMatch[1], line: i + 1 });
    }
    // import('./foo')
    const dynMatch = line.match(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/);
    if (dynMatch) {
      imports.push({ path: dynMatch[1], line: i + 1 });
    }
  }

  return imports;
}

function checkHallucinatedImports(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']);

  for (const file of files) {
    const ext = extname(file);
    if (!sourceExts.has(ext)) continue;
    if (file.includes('node_modules')) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const relImports = extractRelativeImports(content);
    for (const imp of relImports) {
      // Skip .js extensions pointing to .ts files (common in ESM TypeScript)
      // The resolver already handles this
      if (!resolveRelativeImport(imp.path, file, cwd)) {
        issues.push({
          severity: 'error',
          message: `hallucinated import: "${imp.path}" does not resolve to any file`,
          file,
          line: imp.line,
          fixable: false,
        });
      }
    }
  }

  return issues;
}

// ── Empty catch blocks ───────────────────────────────────────────────────────

function checkEmptyCatch(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

  for (const file of files) {
    if (!sourceExts.has(extname(file))) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // catch(e) {} or catch(err) {} — empty catch
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
        issues.push({
          severity: 'error',
          message: 'empty catch block — error silently swallowed',
          file,
          line: i + 1,
          fixable: false,
          fixHint: 'log or handle the error, or add a comment explaining why it is intentional',
        });
        continue;
      }

      // catch {} (no param)
      if (/catch\s*\{\s*\}/.test(line)) {
        issues.push({
          severity: 'error',
          message: 'empty catch block — error silently swallowed',
          file,
          line: i + 1,
          fixable: false,
          fixHint: 'log or handle the error, or add a comment explaining why it is intentional',
        });
        continue;
      }

      // Multi-line: catch block that starts on this line — check if it's comment-only
      const catchStart = line.match(/catch\s*(?:\([^)]*\))?\s*\{/);
      if (catchStart) {
        // Collect lines until matching }
        let depth = 0;
        let blockStart = -1;
        for (let ci = line.indexOf('{'); ci < line.length; ci++) {
          if (line[ci] === '{') { depth++; blockStart = ci; break; }
        }
        if (depth > 0) {
          const blockLines: string[] = [line.slice(blockStart + 1)];
          let j = i + 1;
          while (j < lines.length && depth > 0) {
            const l = lines[j];
            for (const ch of l) {
              if (ch === '{') depth++;
              else if (ch === '}') depth--;
            }
            blockLines.push(l);
            j++;
          }
          // Check if block body is only comments
          const bodyText = blockLines.join('\n').replace(/\}$/, '').trim();
          if (bodyText.length > 0 && /^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*$/.test(bodyText)) {
            issues.push({
              severity: 'warning',
              message: 'catch block contains only comments — consider proper error handling',
              file,
              line: i + 1,
              fixable: false,
            });
          }
        }
      }
    }
  }

  return issues;
}

// ── Stubbed tests ────────────────────────────────────────────────────────────

function checkStubbedTests(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const testExts = /\.(test|spec)\.[jt]sx?$/;

  for (const file of files) {
    if (!testExts.test(file)) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Trivial assertions
      if (/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/.test(line)) {
        issues.push({
          severity: 'error',
          message: 'stubbed test: trivial assertion expect(true).toBe(true)',
          file,
          line: i + 1,
          fixable: false,
        });
      }

      if (/expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/.test(line)) {
        issues.push({
          severity: 'error',
          message: 'stubbed test: trivial assertion expect(1).toBe(1)',
          file,
          line: i + 1,
          fixable: false,
        });
      }

      // Empty test body: test('...', () => {}) or it('...', () => {})
      if (/(?:test|it)\s*\(\s*['"`][^'"]+['"`]\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line)) {
        issues.push({
          severity: 'error',
          message: 'stubbed test: empty test body',
          file,
          line: i + 1,
          fixable: false,
          fixHint: 'add assertions or mark as test.todo()',
        });
      }

      // it.skip without .todo — skipped test (always check regardless of other matches on this line)
      if (/(?:it|test)\.skip\s*\(/.test(line) && !/\.todo\s*\(/.test(line)) {
        issues.push({
          severity: 'warning',
          message: 'skipped test: use test.todo() instead of .skip for unimplemented tests',
          file,
          line: i + 1,
          fixable: true,
          fixHint: 'change .skip to .todo if not yet implemented',
        });
      }
    }
  }

  return issues;
}

// ── Unhandled async (removed error handling) ─────────────────────────────────

function checkUnhandledAsync(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

  for (const file of files) {
    if (!sourceExts.has(extname(file))) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    let unhandledCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // await without try/catch context — detect standalone awaits
      // We look for: const/let/var x = await or just await on its own, not inside try
      const hasAwait = /^\s*(?:const|let|var)\s+\w.*=\s*await\s+/.test(line) || /^\s*await\s+/.test(line);
      if (!hasAwait) continue;

      // Check context window — look for try { in surrounding lines
      const contextStart = Math.max(0, i - 15);
      const contextEnd = Math.min(lines.length - 1, i + 5);
      const contextLines = lines.slice(contextStart, contextEnd + 1);
      const contextText = contextLines.join('\n');

      // Count try/catch blocks in context
      const tryCount = (contextText.match(/\btry\s*\{/g) || []).length;
      const catchCount = (contextText.match(/\bcatch\s*(?:\([^)]*\))?\s*\{/g) || []).length;

      if (tryCount === 0 || catchCount === 0) {
        // Also check for .catch() chained
        const hasCatch = /\.catch\s*\(/.test(line) || (i + 1 < lines.length && /\.catch\s*\(/.test(lines[i + 1]));
        if (!hasCatch) {
          unhandledCount++;
          if (unhandledCount <= 10) {
            issues.push({
              severity: 'warning',
              message: 'unhandled async: await without try/catch',
              file,
              line: i + 1,
              fixable: false,
              fixHint: 'wrap in try/catch or chain .catch()',
            });
          }
        }
      }
    }
  }

  return issues;
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkIntegrity(cwd: string, ignore: string[]): Promise<CheckResult> {
  const files = walkFiles(cwd, ignore);

  const hallucinatedIssues = checkHallucinatedImports(cwd, files);
  const emptyCatchIssues = checkEmptyCatch(cwd, files);
  const stubbedTestIssues = checkStubbedTests(cwd, files);
  const unhandledAsyncIssues = checkUnhandledAsync(cwd, files);

  const allIssues = [
    ...hallucinatedIssues,
    ...emptyCatchIssues,
    ...stubbedTestIssues,
    ...unhandledAsyncIssues,
  ];

  // Scoring: start at 100, penalize per issue type
  let score = 100;
  score -= hallucinatedIssues.length * 10;
  score -= emptyCatchIssues.filter(i => i.severity === 'error').length * 8;
  score -= stubbedTestIssues.filter(i => i.severity === 'error').length * 5;
  // Unhandled async capped at -30
  const unhandledErrors = unhandledAsyncIssues.length;
  score -= Math.min(30, unhandledErrors * 3);
  score = Math.max(0, Math.round(score));

  // Summary parts
  const parts: string[] = [];
  if (hallucinatedIssues.length > 0) parts.push(`${hallucinatedIssues.length} hallucinated import${hallucinatedIssues.length !== 1 ? 's' : ''}`);
  if (emptyCatchIssues.length > 0) parts.push(`${emptyCatchIssues.length} empty catch${emptyCatchIssues.length !== 1 ? 'es' : ''}`);
  if (stubbedTestIssues.length > 0) parts.push(`${stubbedTestIssues.length} stubbed test${stubbedTestIssues.length !== 1 ? 's' : ''}`);
  if (unhandledAsyncIssues.length > 0) parts.push(`${unhandledAsyncIssues.length} unhandled async`);

  return {
    name: 'integrity',
    score,
    maxScore: 100,
    issues: allIssues,
    summary: parts.length === 0 ? 'no integrity issues found' : parts.join(', '),
  };
}
