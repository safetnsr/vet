import { join, resolve, dirname, extname, basename } from 'node:path';
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

function isInsideStringLiteral(line: string, matchIndex: number): boolean {
  // Check if the match position is inside a string literal (template literal, quote)
  // by counting unescaped quotes before the match
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < matchIndex && i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
  }
  // If we're inside a string context AND the line itself is not an import/require statement,
  // then this is likely a string literal containing import-like text
  return inSingle || inDouble || inTemplate;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function extractRelativeImports(source: string): { path: string; line: number }[] {
  const imports: { path: string; line: number }[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines
    if (isCommentLine(line)) continue;
    const trimmed = line.trim();

    // import ... from './foo' or '../bar' — must be an actual import statement
    if (/^\s*(?:import|export)\s/.test(line)) {
      const fromMatch = line.match(/from\s+['"](\.[^'"]+)['"]/);
      if (fromMatch) {
        imports.push({ path: fromMatch[1], line: i + 1 });
      }
    }
    // require('./foo') — must be at statement level, not inside a string
    const reqMatch = line.match(/require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/);
    if (reqMatch && !isInsideStringLiteral(line, line.indexOf(reqMatch[0]))) {
      // Skip if the require is inside a string literal (test fixtures)
      const beforeReq = line.substring(0, line.indexOf(reqMatch[0]));
      if (!/['"`]/.test(beforeReq.slice(-1))) {
        imports.push({ path: reqMatch[1], line: i + 1 });
      }
    }
    // Dynamic import('./foo') — actual import() call, not in string
    if (/^\s*(?:const|let|var|await|return)?\s*/.test(line)) {
      const dynMatch = line.match(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/);
      if (dynMatch && !isCommentLine(line)) {
        // Make sure it's not inside a string literal (e.g. a test describing imports)
        const matchIdx = line.indexOf(dynMatch[0]);
        if (!isInsideStringLiteral(line, matchIdx)) {
          imports.push({ path: dynMatch[1], line: i + 1 });
        }
      }
    }
  }

  return imports;
}

function isBuildArtifactImport(importPath: string): boolean {
  return /(?:^|\/)(?:dist|build)\//.test(importPath);
}

function checkHallucinatedImports(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']);

  for (const file of files) {
    const ext = extname(file);
    if (!sourceExts.has(ext)) continue;
    if (file.includes('node_modules')) continue;

    // Skip .d.ts declaration files — they reference build outputs
    if (file.endsWith('.d.ts')) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const relImports = extractRelativeImports(content);
    for (const imp of relImports) {
      // Skip build artifact imports (./dist/..., ../build/...)
      if (isBuildArtifactImport(imp.path)) continue;
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

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(file) || file.includes('__tests__') || /^test[/\\]/.test(file);
}

function checkEmptyCatch(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

  for (const file of files) {
    if (!sourceExts.has(extname(file))) continue;
    // Skip test files — empty catches in tests are usually intentional (testing error paths)
    if (isTestFile(file)) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // single-line catch with param and empty body — error silently swallowed
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

      // single-line catch without param and empty body
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

/** Files that ARE error boundaries — they handle errors by design */
function isErrorBoundaryFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const base = basename(normalized);
  // Next.js error boundaries
  if (/^error\.[jt]sx?$/.test(base)) return true;
  if (/^global-error\.[jt]sx?$/.test(base)) return true;
  // Middleware files
  if (/^middleware\.[jt]sx?$/.test(base)) return true;
  // Error handler files
  if (/error[-_]?handler/i.test(base)) return true;
  if (/error[-_]?boundary/i.test(base)) return true;
  return false;
}

/** Next.js server component files where framework handles errors */
const NEXTJS_SERVER_FILES = /^(page|layout|loading|not-found|template)\.[jt]sx?$/;

function isNextjsServerComponent(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const base = basename(normalized);
  // Next.js app directory server components
  if (NEXTJS_SERVER_FILES.test(base)) return true;
  // Next.js route handlers (route.ts/js/tsx/jsx) anywhere in app/
  if (/^route\.[jt]sx?$/.test(base)) return true;
  // Any file in app/api/ directory
  if (normalized.includes('app/api/')) return true;
  // Next.js middleware
  if (/^middleware\.[jt]s$/.test(base)) return true;
  return false;
}

/** Check if a file has a top-level error handler (global catch-all) */
function hasGlobalErrorHandling(content: string): boolean {
  // process.on('unhandledRejection'/'uncaughtException')
  if (/process\.on\s*\(\s*['"](?:unhandledRejection|uncaughtException)['"]/i.test(content)) return true;
  // Express/Koa-style error middleware: (err, req, res, next) or app.use with 4 params
  if (/(?:app|router)\.use\s*\(\s*(?:async\s*)?\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/.test(content)) return true;
  // window.addEventListener('error'/'unhandledrejection')
  if (/addEventListener\s*\(\s*['"](?:error|unhandledrejection)['"]/i.test(content)) return true;
  return false;
}

function checkUnhandledAsync(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

  for (const file of files) {
    if (!sourceExts.has(extname(file))) continue;
    // Skip test files — test runners handle errors at the framework level
    if (isTestFile(file)) continue;
    // Skip error boundary files — they ARE the error handlers
    if (isErrorBoundaryFile(file)) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    // Skip files with global error handling
    if (hasGlobalErrorHandling(content)) continue;

    const lines = content.split('\n');
    let unhandledCount = 0;

    // Build a map of which lines are inside try blocks using brace tracking
    const insideTry = new Set<number>();
    const tryStack: { braceDepth: number }[] = [];
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Detect try { 
      if (/\btry\s*\{/.test(line)) {
        tryStack.push({ braceDepth });
      }
      // Count braces
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') {
          braceDepth--;
          // Check if we're closing a try block
          if (tryStack.length > 0 && braceDepth <= tryStack[tryStack.length - 1].braceDepth) {
            tryStack.pop();
          }
        }
      }
      if (tryStack.length > 0) {
        insideTry.add(i);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // await without try/catch context — detect standalone awaits
      const hasAwait = /^\s*(?:const|let|var)\s+\w.*=\s*await\s+/.test(line) || /^\s*await\s+/.test(line);
      if (!hasAwait) continue;

      // Skip if inside a try block (proper scope tracking)
      if (insideTry.has(i)) continue;

      {
        // Check for .catch() chained on this or next line
        const hasCatch = /\.catch\s*\(/.test(line) || (i + 1 < lines.length && /\.catch\s*\(/.test(lines[i + 1]));
        // Check for .then(..., errorHandler) pattern
        const hasThenError = /\.then\s*\([^,]+,\s*\w+/.test(line) || (i + 1 < lines.length && /\.then\s*\([^,]+,\s*\w+/.test(lines[i + 1]));
        if (!hasCatch && !hasThenError) {
          unhandledCount++;
          // Downgrade Next.js server components to info (framework handles errors)
          const isServerComp = isNextjsServerComponent(file);
          if (unhandledCount <= 10) {
            issues.push({
              severity: isServerComp ? 'info' : 'warning',
              message: isServerComp
                ? 'unhandled async: await without try/catch (Next.js server component — framework-managed)'
                : 'unhandled async: await without try/catch',
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
  // Unhandled async capped at -30 (only count warnings, not info-downgraded ones)
  const unhandledErrors = unhandledAsyncIssues.filter(i => i.severity === 'warning').length;
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
