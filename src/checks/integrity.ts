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
  let inTemplateLiteral = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track template literal context — check state at start of line, then update
    const wasInTemplate = inTemplateLiteral;
    for (let ci = 0; ci < line.length; ci++) {
      if (line[ci] === '\\') { ci++; continue; }
      if (line[ci] === '`') inTemplateLiteral = !inTemplateLiteral;
    }

    // Skip lines that start inside a template literal — they contain generated code, not real imports
    if (wasInTemplate) continue;

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
    // Skip example/demo directories — example code doesn't need production error handling
    if (/(?:^|[/\\])(?:examples?|demos?)[/\\]/.test(file)) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // single-line catch with param and empty body — warning (was error, too harsh)
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
        issues.push({
          severity: 'warning',
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
          severity: 'warning',
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
            // If the comment contains TODO/FIXME/HACK/XXX/WIP/implement, keep as warning (unfinished work)
            // TEMP only as standalone marker (not "temporary" used as adjective)
            // Otherwise, any comment text means someone documented why it's empty → downgrade to info
            const unfinishedRe = /\b(TODO|FIXME|HACK|XXX|WIP|implement)\b|\bTEMP\b(?!orar)/i;
            const sev = unfinishedRe.test(bodyText) ? 'warning' : 'info';
            issues.push({
              severity: sev,
              message: sev === 'info'
                ? 'catch block with intentional comment — acknowledged'
                : 'catch block contains only comments — consider proper error handling',
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

/**
 * Build a per-line map of enclosing function info:
 * - whether the function has any try/catch in its body
 * - whether the function is exported
 */
interface FuncScope {
  startLine: number;
  endLine: number;
  hasTryCatch: boolean;
  isExported: boolean;
}

function buildFuncScopes(lines: string[]): FuncScope[] {
  const scopes: FuncScope[] = [];
  // Find function start lines
  const funcStarts: { line: number; isExported: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // function declarations and arrow functions
    const isFuncDecl = /(?:async\s+)?function\s+\w/.test(l) && /\{/.test(l);
    const isArrow = /=>\s*\{/.test(l);
    const isMethod = /^\s+(?:async\s+)?\w+\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/.test(l) && !/\b(?:if|for|while|switch|catch)\b/.test(l);
    if (isFuncDecl || isArrow || isMethod) {
      const isExported = /^\s*export\s/.test(l) || (i > 0 && /^\s*export\s/.test(lines[i - 1]));
      funcStarts.push({ line: i, isExported });
    }
  }

  for (const fs of funcStarts) {
    // Find the opening brace on the start line
    let braceIdx = lines[fs.line].indexOf('{');
    if (braceIdx === -1) continue;
    let depth = 0;
    let endLine = fs.line;
    let hasTry = false;
    for (let i = fs.line; i < lines.length; i++) {
      const startJ = i === fs.line ? braceIdx : 0;
      for (let j = startJ; j < lines[i].length; j++) {
        if (lines[i][j] === '{') depth++;
        if (lines[i][j] === '}') {
          depth--;
          if (depth === 0) { endLine = i; break; }
        }
      }
      if (/\btry\s*\{/.test(lines[i])) hasTry = true;
      if (depth === 0) break;
    }
    scopes.push({ startLine: fs.line, endLine, hasTryCatch: hasTry, isExported: fs.isExported });
  }
  return scopes;
}

function findEnclosingFunc(scopes: FuncScope[], lineIdx: number): FuncScope | null {
  // Find the tightest (smallest range) enclosing function
  let best: FuncScope | null = null;
  for (const s of scopes) {
    if (lineIdx >= s.startLine && lineIdx <= s.endLine) {
      if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) {
        best = s;
      }
    }
  }
  return best;
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
    // Skip example/demo directories — example code doesn't need production error handling
    if (/(?:^|[/\\])(?:examples?|demos?)[/\\]/.test(file)) continue;

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

    // Build function scope info for severity decisions
    const funcScopes = buildFuncScopes(lines);

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

          // Determine severity:
          // - 'info' for Next.js server components, or functions that have try/catch elsewhere in their body
          // - 'warning' only for exported functions with NO try/catch anywhere
          // - 'info' for everything else (non-exported, internal functions)
          const isServerComp = isNextjsServerComponent(file);
          const enclosing = findEnclosingFunc(funcScopes, i);
          const hasFuncTryCatch = enclosing?.hasTryCatch ?? false;
          const isExported = enclosing?.isExported ?? false;

          let severity: 'warning' | 'info';
          if (isServerComp || hasFuncTryCatch) {
            severity = 'info';
          } else if (isExported) {
            severity = 'warning';
          } else {
            severity = 'info';
          }

          if (unhandledCount <= 10) {
            issues.push({
              severity,
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

  // Scoring: start at 100, penalize per issue type (size-normalized)
  const srcFiles = files.filter(f => /\.(ts|tsx|js|jsx|mts|mjs)$/.test(f));
  const fileCount = srcFiles.length;
  const sizeScale = fileCount <= 10 ? 1.0 : Math.max(0.3, 1.0 - Math.log10(fileCount / 10) * 0.4);

  let score = 100;
  score -= hallucinatedIssues.length * 10 * sizeScale;
  score -= emptyCatchIssues.filter(i => i.severity === 'error').length * 8 * sizeScale;
  score -= emptyCatchIssues.filter(i => i.severity === 'warning').length * 3 * sizeScale;
  score -= stubbedTestIssues.filter(i => i.severity === 'error').length * 5 * sizeScale;
  // Unhandled async capped at -15 (only count warnings, not info-downgraded ones)
  const unhandledWarnings = unhandledAsyncIssues.filter(i => i.severity === 'warning').length;
  score -= Math.min(15, unhandledWarnings * 3 * sizeScale);
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
