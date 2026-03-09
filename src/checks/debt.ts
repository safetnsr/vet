import { join, basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { walkFiles, readFile, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface FuncInfo {
  name: string;
  body: string;
  normalized: string;
  hash: string;
  file: string;
  line: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx']);

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTS.has(f.substring(dot));
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__') || /(?:^|[/\\])tests?[/\\]/.test(f);
}

function isEntryFile(f: string): boolean {
  const b = basename(f);
  return /^(cli|main|index)\.[jt]sx?$/.test(b);
}

// Next.js / Remix / SvelteKit / Nuxt convention exports consumed by the framework, not via imports
const FRAMEWORK_CONVENTION_EXPORTS = new Set([
  // Next.js App Router
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
  'metadata', 'generateMetadata', 'generateStaticParams', 'generateViewport',
  'viewport', 'runtime', 'revalidate', 'dynamic', 'dynamicParams',
  'fetchCache', 'preferredRegion', 'maxDuration',
  'default', // default export in page/layout/route files
  // Next.js Pages Router
  'getServerSideProps', 'getStaticProps', 'getStaticPaths',
  // Remix
  'loader', 'action', 'meta', 'links', 'headers', 'handle',
  'shouldRevalidate', 'ErrorBoundary', 'HydrateFallback',
  // SvelteKit
  'load', 'prerender', 'ssr', 'csr', 'trailingSlash',
  // Nuxt
  'definePageMeta', 'useHead',
]);

function isFrameworkConventionFile(file: string): boolean {
  // Next.js app router: app/**/page.tsx, layout.tsx, route.tsx, loading.tsx, error.tsx, etc.
  if (/\/(app|pages)\//.test(file) && /\/(page|layout|route|loading|error|not-found|template|default|middleware)\.[jt]sx?$/.test(file)) return true;
  // Next.js API routes
  if (/\/api\//.test(file) && /\/route\.[jt]sx?$/.test(file)) return true;
  // Remix routes
  if (/\/routes\//.test(file) && /\.[jt]sx?$/.test(file)) return true;
  // SvelteKit
  if (/\+(page|layout|server|error)\.[jt]s/.test(file)) return true;
  return false;
}

function isBarrelFile(f: string): boolean {
  const b = basename(f);
  return /^index\.[jt]sx?$/.test(b);
}

/** Normalize a function body for comparison */
function normalize(body: string): string {
  let s = body;
  // Replace string literals
  s = s.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '"S"');
  // Replace number literals (but not in identifiers)
  s = s.replace(/\b\d+\.?\d*\b/g, '0');
  // Strip whitespace
  s = s.replace(/\s+/g, '');
  // Collapse variable names to single char (simple: replace camelCase identifiers)
  s = s.replace(/\b[a-z][a-zA-Z0-9]{3,}\b/g, 'V');
  return s;
}

/** Simple string hash */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** Levenshtein distance (optimized single-row DP, with early exit) */
function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is shorter for memory efficiency
  if (a.length > b.length) { const t = a; a = b; b = t; }

  const aLen = a.length;
  const bLen = b.length;

  // For very long strings, use sampled comparison instead of full DP
  if (aLen > 500) {
    return sampledDistance(a, b, maxDist);
  }

  const row = new Uint32Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) row[i] = i;

  for (let j = 1; j <= bLen; j++) {
    let prev = row[0];
    row[0] = j;
    let rowMin = j;
    for (let i = 1; i <= aLen; i++) {
      const cur = row[i];
      if (a[i - 1] === b[j - 1]) {
        row[i] = prev;
      } else {
        row[i] = 1 + Math.min(prev, row[i], row[i - 1]);
      }
      prev = cur;
      if (row[i] < rowMin) rowMin = row[i];
    }
    // Early exit if minimum in this row already exceeds threshold
    if (rowMin > maxDist) return rowMin;
  }
  return row[aLen];
}

/** Fast sampled distance for long strings — compare chunks instead of full DP */
function sampledDistance(a: string, b: string, maxDist: number): number {
  const maxLen = Math.max(a.length, b.length);
  // Sample 5 chunks of 80 chars each from evenly spaced positions
  const chunkSize = 80;
  const samples = 5;
  let totalDiff = 0;
  let totalSampled = 0;

  for (let s = 0; s < samples; s++) {
    const pos = Math.floor((s / samples) * (Math.min(a.length, b.length) - chunkSize));
    if (pos < 0) continue;
    const ca = a.substring(pos, pos + chunkSize);
    const cb = b.substring(pos, pos + chunkSize);
    let diff = 0;
    for (let i = 0; i < chunkSize; i++) {
      if (ca[i] !== cb[i]) diff++;
    }
    totalDiff += diff;
    totalSampled += chunkSize;
  }

  if (totalSampled === 0) return maxLen;
  // Extrapolate
  const estDist = Math.round((totalDiff / totalSampled) * maxLen);
  return estDist;
}

/** Similarity ratio between two strings (0-1) */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  // Quick reject: if length diff alone makes similarity impossible
  const lenDiff = Math.abs(a.length - b.length);
  if (1 - lenDiff / maxLen < 0.92) return 0;
  const maxDist = Math.floor(maxLen * 0.08); // 92% similarity = 8% max distance
  const dist = levenshtein(a, b, maxDist);
  return 1 - dist / maxLen;
}

/** Extract function bodies with brace matching */
function extractBraceBody(source: string, startIdx: number): string | null {
  let idx = source.indexOf('{', startIdx);
  if (idx === -1) return null;
  let depth = 0;
  const start = idx;
  for (let i = idx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.substring(start + 1, i);
    }
  }
  return null;
}

/** Get line number for a character index */
function lineAt(source: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** Extract all named functions from source */
function extractFunctions(source: string, file: string): FuncInfo[] {
  const fns: FuncInfo[] = [];

  // Named function declarations: function name(...)
  const funcDeclRe = /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)[^{]*/g;
  let match: RegExpExecArray | null;
  while ((match = funcDeclRe.exec(source)) !== null) {
    const body = extractBraceBody(source, match.index + match[0].length - 1);
    if (body && body.trim().length > 10) {
      const norm = normalize(body);
      fns.push({
        name: match[1],
        body,
        normalized: norm,
        hash: simpleHash(norm),
        file,
        line: lineAt(source, match.index),
      });
    }
  }

  // Arrow function assignments: const/let/var name = (...) => { ... }
  // Also: export const name = (...) => { ... }
  const arrowRe = /\b(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]*?)?\s*=>\s*\{/g;
  while ((match = arrowRe.exec(source)) !== null) {
    const braceStart = source.indexOf('{', match.index + match[0].length - 1);
    const body = extractBraceBody(source, braceStart);
    if (body && body.trim().length > 10) {
      const norm = normalize(body);
      fns.push({
        name: match[1],
        body,
        normalized: norm,
        hash: simpleHash(norm),
        file,
        line: lineAt(source, match.index),
      });
    }
  }

  return fns;
}

// ── A) Near-duplicate detection ──────────────────────────────────────────────

/** Check if functions are in a numbered spec implementation pattern (e.g. asi01, asi02...) */
function isSpecPattern(group: FuncInfo[]): boolean {
  if (group.length < 3) return false;
  const dirs = new Set(group.map(f => f.file.substring(0, f.file.lastIndexOf('/'))));
  if (dirs.size !== 1) return false; // must be same directory
  // Check if filenames follow a numbered pattern
  const bases = group.map(f => f.file.substring(f.file.lastIndexOf('/') + 1));
  const numbered = bases.filter(b => /\d{2}/.test(b));
  return numbered.length >= 3;
}

function findDuplicates(allFuncs: FuncInfo[]): Issue[] {
  const issues: Issue[] = [];
  const groups = new Map<string, FuncInfo[]>();

  // Group by hash first (exact normalized match)
  for (const fn of allFuncs) {
    const existing = groups.get(fn.hash) || [];
    existing.push(fn);
    groups.set(fn.hash, existing);
  }

  const reported = new Set<string>();

  // Exact duplicates (only flag if normalized body is substantial)
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    // Skip if the normalized body is too generic (short functions normalize to same hash easily)
    if (group[0].normalized.length < 65) continue;
    // Deduplicate by name+file
    const key = group.map(f => `${f.file}:${f.name}`).sort().join('|');
    if (reported.has(key)) continue;
    reported.add(key);

    // Skip groups that follow a numbered spec pattern (e.g., ASI01-ASI10 checks)
    if (isSpecPattern(group)) continue;

    const locations = group.map(f => `${f.name} (${f.file}:${f.line})`).join(', ');
    // Downgrade to info if all functions in the group are in test directories
    // or if any function is in an examples/demo directory
    const allInTest = group.every(f => isInTestDir(f.file));
    const anyInExample = group.some(f => /(?:^|[/\\])(?:examples?|demos?|templates?|fixtures?)[/\\]/.test(f.file));
    issues.push({
      severity: (allInTest || anyInExample) ? 'info' : 'warning',
      message: `near-duplicate functions: ${locations}`,
      file: group[0].file,
      line: group[0].line,
      fixable: !(allInTest || anyInExample),
      fixHint: (allInTest || anyInExample) ? 'duplication in examples/tests is often intentional' : 'extract shared logic into a single function',
    });
  }

  // Similarity check for non-exact matches — length-bucketed to avoid O(n²) explosion
  // Only consider functions with substantial normalized bodies (>= 65 chars)
  const singles = allFuncs.filter(fn => {
    const g = groups.get(fn.hash);
    return (!g || g.length < 2) && fn.normalized.length >= 65;
  });

  // Sort by normalized length so we can break early when lengths diverge
  singles.sort((a, b) => a.normalized.length - b.normalized.length);

  let comparisons = 0;
  const MAX_COMPARISONS = 200_000; // safety cap

  for (let i = 0; i < singles.length && comparisons < MAX_COMPARISONS; i++) {
    const a = singles[i];
    for (let j = i + 1; j < singles.length; j++) {
      const b = singles[j];
      // If b is >25% longer than a, skip rest (sorted, so all further are longer)
      if (b.normalized.length > a.normalized.length * 1.25) break;
      comparisons++;
      if (comparisons > MAX_COMPARISONS) break;
      const sim = similarity(a.normalized, b.normalized);
      if (sim > 0.92) {
        const key = [a.file + ':' + a.name, b.file + ':' + b.name].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        // Downgrade to info if both functions are in test directories
        // or if either is in an examples/demo directory
        const bothInTest = isInTestDir(a.file) && isInTestDir(b.file);
        const anyInExample = /(?:^|[/\\])(?:examples?|demos?|templates?|fixtures?)[/\\]/.test(a.file) || /(?:^|[/\\])(?:examples?|demos?|templates?|fixtures?)[/\\]/.test(b.file);
        issues.push({
          severity: (bothInTest || anyInExample) ? 'info' : 'warning',
          message: `similar functions (${Math.round(sim * 100)}%): ${a.name} (${a.file}:${a.line}) and ${b.name} (${b.file}:${b.line})`,
          file: a.file,
          line: a.line,
          fixable: !(bothInTest || anyInExample),
          fixHint: (bothInTest || anyInExample) ? 'duplication in examples/tests is often intentional' : 'consider merging or extracting shared logic',
        });
      }
    }
  }

  return issues;
}

// ── B) Orphaned exports ──────────────────────────────────────────────────────

function isLibrary(cwd: string): boolean {
  try {
    const raw = readFile(join(cwd, 'package.json'));
    if (!raw) return false;
    const pkg = JSON.parse(raw);
    return !!(pkg.main || pkg.exports || pkg.module || pkg.types || pkg.bin);
  } catch { return false; }
}

function isMonorepo(cwd: string): boolean {
  try {
    const pkgRaw = readFile(join(cwd, 'package.json'));
    if (pkgRaw) {
      const pkg = JSON.parse(pkgRaw);
      if (Array.isArray(pkg.workspaces) || pkg.workspaces?.packages) return true;
    }
  } catch { /* skip */ }
  if (existsSync(join(cwd, 'pnpm-workspace.yaml'))) return true;
  if (existsSync(join(cwd, 'lerna.json'))) return true;
  return false;
}

/** Find nearest package.json upward from a file path, check if it's a library */
function isFileInLibraryPackage(cwd: string, filePath: string): boolean {
  let dir = dirname(join(cwd, filePath));
  const root = cwd;
  while (dir.length >= root.length) {
    const pkgPath = join(dir, 'package.json');
    try {
      const raw = readFile(pkgPath);
      if (raw) {
        // Don't count the root package.json — we already check that via isLibrary
        if (dir === root) return false;
        const pkg = JSON.parse(raw);
        return !!(pkg.main || pkg.exports || pkg.module || pkg.types || pkg.bin);
      }
    } catch { /* skip */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function findOrphanedExports(cwd: string, files: string[]): Issue[] {
  const issues: Issue[] = [];
  const sourceFiles = files.filter(f => isSourceFile(f) && !isTestFile(f));

  // Collect all named exports
  const exports: { name: string; file: string; line: number }[] = [];

  for (const file of sourceFiles) {
    if (isBarrelFile(file) || isEntryFile(file)) continue;
    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // export function name
      const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (funcMatch) {
        exports.push({ name: funcMatch[1], file, line: i + 1 });
        continue;
      }

      // export const/let/var name
      const constMatch = line.match(/^export\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (constMatch) {
        exports.push({ name: constMatch[1], file, line: i + 1 });
        continue;
      }

      // export { name, name2 } — but skip type exports
      if (/^export\s+type\s/.test(line)) continue;
      const braceMatch = line.match(/^export\s*\{([^}]+)\}/);
      if (braceMatch) {
        for (const part of braceMatch[1].split(',')) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          // export { x as y } — use the alias (y) as the exported name, since that's what consumers see
          const asParts = trimmed.split(/\s+as\s+/);
          const exportedName = (asParts.length > 1 ? asParts[1] : asParts[0]).trim();
          if (exportedName === 'default' || exportedName === 'type') continue;
          exports.push({ name: exportedName, file, line: i + 1 });
        }
      }
    }
  }

  // Scan ALL files (including tests) for import names — an export consumed by a test is not orphaned
  const importedNames = new Set<string>();
  const importRe = /import\s+(?:type\s+)?(?:\{([^}]+)\}|([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*,\s*\{([^}]+)\})?)\s+from\s+/g;

  // Also scan for dynamic imports: require('x'), import('x') — to catch non-static usage
  const dynamicImportRe = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  const allSourceFiles = files.filter(f => isSourceFile(f));

  // Track which files are re-exported via `export * from './x'`
  const reExportedFiles = new Set<string>();
  const exportFromRe = /export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/g;
  const exportNamedFromRe = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;

  for (const file of allSourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    let match: RegExpExecArray | null;

    // Standard imports
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      const namedParts = [match[1], match[3]].filter(Boolean);
      for (const part of namedParts) {
        for (const name of part.split(',')) {
          const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
          if (trimmed) importedNames.add(trimmed);
        }
      }
      if (match[2]) importedNames.add(match[2]);
    }

    // `export * from './module'` — all exports from that module are consumed
    exportFromRe.lastIndex = 0;
    while ((match = exportFromRe.exec(content)) !== null) {
      // Resolve the re-exported file relative to current file
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const dir = dirname(file);
        const candidates = [
          join(dir, specifier),
          join(dir, specifier + '.ts'), join(dir, specifier + '.tsx'),
          join(dir, specifier + '.js'), join(dir, specifier + '.jsx'),
          join(dir, specifier, 'index.ts'), join(dir, specifier, 'index.tsx'),
          join(dir, specifier, 'index.js'),
        ];
        for (const c of candidates) {
          const normalized = c.replace(/\\/g, '/');
          reExportedFiles.add(normalized);
        }
      }
    }

    // `export { name } from './module'` — named re-exports count as imports
    exportNamedFromRe.lastIndex = 0;
    while ((match = exportNamedFromRe.exec(content)) !== null) {
      for (const name of match[1].split(',')) {
        const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
        if (trimmed) importedNames.add(trimmed);
      }
    }
  }

  // Build a cross-reference map: for each exported name, check if it appears in other files
  // This catches hook returns ({ Component } = useHook()), dynamic usage, re-exports, JSX, etc.
  // Only build refs for names we actually export (not all identifiers — too expensive)
  const exportNames = new Set(exports.map(e => e.name));
  const nameToFiles = new Map<string, Set<string>>();
  for (const name of exportNames) nameToFiles.set(name, new Set());
  for (const file of allSourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    for (const name of exportNames) {
      if (content.includes(name)) {
        nameToFiles.get(name)!.add(file);
      }
    }
  }

  const lib = isLibrary(cwd);
  const mono = isMonorepo(cwd);

  for (const exp of exports) {
    if (!importedNames.has(exp.name)) {
      // Skip if the file is re-exported via `export * from './file'`
      const normalizedFile = exp.file.replace(/\\/g, '/');
      if (reExportedFiles.has(normalizedFile)) continue;
      // Cross-reference check: if the export name appears in a different file, it's likely used
      const refs = nameToFiles.get(exp.name);
      if (refs) {
        const otherFiles = new Set(refs);
        otherFiles.delete(exp.file);
        if (otherFiles.size > 0) continue;
      }
      // Skip framework convention exports (Next.js, Remix, SvelteKit, Nuxt)
      if (FRAMEWORK_CONVENTION_EXPORTS.has(exp.name) && isFrameworkConventionFile(exp.file)) continue;
      // In monorepos, check if the export's file is inside a workspace package that is a library
      const isLib = lib || (mono && isFileInLibraryPackage(cwd, exp.file));
      issues.push({
        severity: isLib ? 'info' : 'warning',
        message: `orphaned export: "${exp.name}" is exported but never imported${isLib ? ' (library detected — exports may be consumed externally)' : ''}`,
        file: exp.file,
        line: exp.line,
        fixable: !isLib,
        fixHint: isLib ? 'may be public API — verify if still needed' : 'remove the export keyword or delete the function',
      });
    }
  }

  return issues;
}

// ── C) Wrapper pass-throughs ─────────────────────────────────────────────────

function findWrappers(allFuncs: FuncInfo[]): Issue[] {
  const issues: Issue[] = [];

  for (const fn of allFuncs) {
    const trimmed = fn.body.trim();
    // return someFn(args) or return someFn(...args)
    if (/^return\s+[a-zA-Z_$][a-zA-Z0-9_$.]*\s*\([^)]*\)\s*;?\s*$/.test(trimmed)) {
      issues.push({
        severity: 'info',
        message: `wrapper pass-through: ${fn.name} just delegates to another function`,
        file: fn.file,
        line: fn.line,
        fixable: true,
        fixHint: 'call the inner function directly instead',
      });
    }
  }

  return issues;
}

// ── D) Naming drift ─────────────────────────────────────────────────────────

function findNamingDrift(allFuncs: FuncInfo[]): Issue[] {
  const issues: Issue[] = [];

  // Common prefixes that indicate the same action
  const actionPrefixes = ['get', 'fetch', 'load', 'retrieve', 'find', 'query', 'read', 'create', 'make', 'build', 'generate', 'set', 'update', 'save', 'write', 'delete', 'remove', 'destroy', 'handle', 'process', 'parse', 'format', 'validate', 'check', 'verify', 'is', 'has', 'can', 'should', 'init', 'setup', 'configure', 'start', 'stop', 'enable', 'disable', 'show', 'hide', 'render', 'display', 'transform', 'convert', 'map', 'filter', 'reduce', 'sort', 'merge', 'split', 'join', 'send', 'emit', 'dispatch', 'trigger', 'on', 'listen', 'subscribe', 'publish', 'notify', 'log', 'print', 'debug', 'warn', 'error'];

  // Extract suffix groups: for each function name, find its suffix after stripping known prefixes
  const suffixMap = new Map<string, { prefix: string; name: string; file: string }[]>();

  for (const fn of allFuncs) {
    const name = fn.name;
    for (const prefix of actionPrefixes) {
      if (name.length > prefix.length && name.startsWith(prefix) && name[prefix.length] === name[prefix.length].toUpperCase()) {
        const suffix = name.substring(prefix.length);
        const existing = suffixMap.get(suffix) || [];
        // Avoid duplicate entries
        if (!existing.some(e => e.name === name)) {
          existing.push({ prefix, name, file: fn.file });
          suffixMap.set(suffix, existing);
        }
        break;
      }
    }
  }

  for (const [suffix, entries] of suffixMap) {
    const uniquePrefixes = new Set(entries.map(e => e.prefix));
    if (uniquePrefixes.size >= 3) {
      const names = entries.map(e => e.name).join(', ');
      issues.push({
        severity: 'info',
        message: `naming drift: ${uniquePrefixes.size} prefixes for "${suffix}": ${names}`,
        fixable: false,
        fixHint: 'standardize on one prefix pattern',
      });
    }
  }

  return issues;
}

// ── Main check ───────────────────────────────────────────────────────────────

/** Check if a file path is in a test directory or is a test file */
function isInTestDir(file: string): boolean {
  return /(?:^|[/\\])(?:test|tests|__tests__)[/\\]/.test(file) || /\.(?:test|spec)\.[jt]sx?$/.test(file);
}

export async function checkDebt(cwd: string, ignore: string[]): Promise<CheckResult> {
  const allFiles = walkFiles(cwd, ignore);
  const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f));

  if (sourceFiles.length === 0) {
    return {
      name: 'debt',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no source files to analyze',
    };
  }

  // Extract all functions
  const allFuncs: FuncInfo[] = [];
  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    allFuncs.push(...extractFunctions(content, file));
  }

  const issues: Issue[] = [];

  // A) Duplicates
  const dupIssues = findDuplicates(allFuncs);
  issues.push(...dupIssues);

  // B) Orphaned exports
  const orphanIssues = findOrphanedExports(cwd, allFiles);
  issues.push(...orphanIssues);

  // C) Wrappers
  const wrapperIssues = findWrappers(allFuncs);
  issues.push(...wrapperIssues);

  // D) Naming drift
  const driftIssues = findNamingDrift(allFuncs);
  issues.push(...driftIssues);

  // ── Scoring (size-normalized) ─────────────────────────────────────────────
  // Scale penalties by project size: a repo with 200 files should tolerate
  // more absolute issues than one with 10 files. The scaling factor ranges
  // from 1.0 (≤10 files) to 0.3 (500+ files), using log scale.
  const fileCount = sourceFiles.length;
  const sizeScale = fileCount <= 10 ? 1.0 : Math.max(0.3, 1.0 - Math.log10(fileCount / 10) * 0.4);

  const dupPenalty = Math.min(50, dupIssues.length * 8) * sizeScale;
  const orphanWarnings = orphanIssues.filter(i => i.severity === 'warning');
  const orphanPenalty = Math.min(30, orphanWarnings.length * 5) * sizeScale;
  const wrapperWarnings = wrapperIssues.filter(i => i.severity === 'warning');
  const driftWarnings = driftIssues.filter(i => i.severity === 'warning');
  const wrapperPenalty = Math.min(15, wrapperWarnings.length * 3) * sizeScale;
  const driftPenalty = Math.min(10, driftWarnings.length * 2) * sizeScale;

  const rawScore = 100 - dupPenalty - orphanPenalty - wrapperPenalty - driftPenalty;
  const finalScore = Math.max(0, Math.round(rawScore));

  // ── Summary ──────────────────────────────────────────────────────────────
  const parts: string[] = [];
  if (dupIssues.length > 0) parts.push(`${dupIssues.length} duplicate${dupIssues.length !== 1 ? 's' : ''}`);
  if (orphanIssues.length > 0) parts.push(`${orphanIssues.length} orphaned export${orphanIssues.length !== 1 ? 's' : ''}`);
  if (wrapperIssues.length > 0) parts.push(`${wrapperIssues.length} wrapper${wrapperIssues.length !== 1 ? 's' : ''}`);
  if (driftIssues.length > 0) parts.push(`${driftIssues.length} naming drift`);

  const summary = parts.length === 0
    ? `${sourceFiles.length} files analyzed, no technical debt found`
    : `${sourceFiles.length} files: ${parts.join(', ')}`;

  return {
    name: 'debt',
    score: finalScore,
    maxScore: 100,
    issues,
    summary,
  };
}
