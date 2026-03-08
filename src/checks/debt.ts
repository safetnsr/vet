import { join, basename } from 'node:path';
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
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__') || f.startsWith('test/') || f.startsWith('test\\');
}

function isEntryFile(f: string): boolean {
  const b = basename(f);
  return /^(cli|main|index)\.[jt]sx?$/.test(b);
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

/** Similarity ratio between two strings (0-1) */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  // Count matching characters in sequence
  let matches = 0;
  const used = new Array(longer.length).fill(false);
  for (let i = 0; i < shorter.length; i++) {
    for (let j = 0; j < longer.length; j++) {
      if (!used[j] && shorter[i] === longer[j]) {
        matches++;
        used[j] = true;
        break;
      }
    }
  }
  return matches / longer.length;
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
    issues.push({
      severity: 'warning',
      message: `near-duplicate functions: ${locations}`,
      file: group[0].file,
      line: group[0].line,
      fixable: true,
      fixHint: 'extract shared logic into a single function',
    });
  }

  // Similarity check for non-exact matches
  const singles = allFuncs.filter(fn => {
    const g = groups.get(fn.hash);
    return !g || g.length < 2;
  });

  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i];
      const b = singles[j];
      // Skip very short normalized bodies
      if (a.normalized.length < 30 || b.normalized.length < 30) continue;
      const sim = similarity(a.normalized, b.normalized);
      if (sim > 0.92) {
        const key = [a.file + ':' + a.name, b.file + ':' + b.name].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        issues.push({
          severity: 'warning',
          message: `similar functions (${Math.round(sim * 100)}%): ${a.name} (${a.file}:${a.line}) and ${b.name} (${b.file}:${b.line})`,
          file: a.file,
          line: a.line,
          fixable: true,
          fixHint: 'consider merging or extracting shared logic',
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
        const names = braceMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const name of names) {
          if (name === 'default' || name === 'type') continue;
          exports.push({ name, file, line: i + 1 });
        }
      }
    }
  }

  // Scan all files for imports of each name
  const allContent: string[] = [];
  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (content) allContent.push(content);
  }
  const allText = allContent.join('\n');

  const lib = isLibrary(cwd);

  for (const exp of exports) {
    // Check if name appears in import statements across all files
    // import { name } from or import { x, name } from or import { name as y }
    const importPattern = new RegExp(`import\\s+[^;]*\\b${exp.name}\\b[^;]*from\\s+`, 'm');
    if (!importPattern.test(allText)) {
      issues.push({
        severity: lib ? 'info' : 'warning',
        message: `orphaned export: "${exp.name}" is exported but never imported${lib ? ' (library detected — exports may be consumed externally)' : ''}`,
        file: exp.file,
        line: exp.line,
        fixable: true,
        fixHint: lib ? 'may be public API — verify if still needed' : 'remove the export keyword or delete the function',
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

  // ── Scoring ──────────────────────────────────────────────────────────────
  const dupPenalty = Math.min(50, dupIssues.length * 8);
  const orphanWarnings = orphanIssues.filter(i => i.severity === 'warning');
  const orphanPenalty = Math.min(30, orphanWarnings.length * 5);
  const wrapperWarnings = wrapperIssues.filter(i => i.severity === 'warning');
  const driftWarnings = driftIssues.filter(i => i.severity === 'warning');
  const wrapperPenalty = Math.min(15, wrapperWarnings.length * 3);
  const driftPenalty = Math.min(10, driftWarnings.length * 2);

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
