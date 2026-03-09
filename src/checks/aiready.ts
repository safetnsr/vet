import { join, dirname, sep } from 'node:path';
import { walkFiles, readFile, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']);

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTS.has(f.substring(dot));
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__') || /(?:^|[/\\])tests?[/\\]/.test(f);
}

function isTsFile(f: string): boolean {
  return /\.[mc]?tsx?$/.test(f);
}

// ── Function extraction (regex-based) ────────────────────────────────────────

interface FuncInfo {
  name: string;
  file: string;
  line: number;
  lineCount: number;
  paramCount: number;
  hasReturnType: boolean;
  isTyped: boolean; // file is .ts/.tsx
}

function extractFunctions(file: string, content: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  const lines = content.split('\n');
  const isTs = isTsFile(file);

  // Match function declarations, arrow functions, methods
  const funcStartRe = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)(?:\s*:\s*[^{]+)?\s*\{/;
  const arrowRe = /^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+)?\s*=>/;
  const methodRe = /^\s+(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)(?:\s*:\s*[^{]+)?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = line.match(funcStartRe) || line.match(arrowRe) || line.match(methodRe);
    if (!match) continue;

    const name = match[1];
    if (!name || name === 'if' || name === 'for' || name === 'while' || name === 'switch') continue;

    const params = match[2] || '';
    const paramCount = params.trim() === '' ? 0 : params.split(',').length;
    const hasReturnType = /\)\s*:\s*[^{]/.test(line);

    // Count function body lines (find matching closing brace)
    let depth = 0;
    let started = false;
    let endLine = i;
    for (let j = i; j < lines.length && j < i + 500; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }
      if (started && depth <= 0) { endLine = j; break; }
    }

    funcs.push({
      name,
      file,
      line: i + 1,
      lineCount: endLine - i + 1,
      paramCount,
      hasReturnType,
      isTyped: isTs,
    });
  }

  return funcs;
}

// ── Import graph for context load ────────────────────────────────────────────

function buildImportCounts(cwd: string, sourceFiles: string[]): Map<string, number> {
  const importCounts = new Map<string, number>(); // file → number of local imports

  const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;

    let count = 0;
    let match: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      const spec = match[1] || match[2];
      if (spec && spec.startsWith('.')) count++;
    }
    importCounts.set(file, count);
  }

  return importCounts;
}

// ── File structure analysis ─────────────────────────────────────────────────

interface StructureMetrics {
  maxDepth: number;
  avgDepth: number;
  avgFilesPerDir: number;
  namingConsistency: number; // 0-1, 1 = all same convention
}

function analyzeStructure(files: string[]): StructureMetrics {
  const dirs = new Map<string, number>(); // dir → file count
  let totalDepth = 0;
  let maxDepth = 0;

  // Naming conventions
  let camelCase = 0;
  let kebabCase = 0;
  let snakeCase = 0;
  let pascalCase = 0;

  for (const file of files) {
    const parts = file.split(/[/\\]/);
    const depth = parts.length - 1;
    totalDepth += depth;
    if (depth > maxDepth) maxDepth = depth;

    const dir = parts.slice(0, -1).join('/') || '.';
    dirs.set(dir, (dirs.get(dir) || 0) + 1);

    // Check file naming convention (without extension)
    const name = parts[parts.length - 1].replace(/\.[^.]+$/, '');
    if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) camelCase++;
    else if (/^[a-z][a-z0-9-]*$/.test(name) && name.includes('-')) kebabCase++;
    else if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes('_')) snakeCase++;
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascalCase++;
  }

  const total = camelCase + kebabCase + snakeCase + pascalCase;
  const dominant = Math.max(camelCase, kebabCase, snakeCase, pascalCase);
  const namingConsistency = total > 0 ? dominant / total : 1;

  const dirCounts = Array.from(dirs.values());
  const avgFilesPerDir = dirCounts.length > 0 ? dirCounts.reduce((a, b) => a + b, 0) / dirCounts.length : 0;

  return {
    maxDepth,
    avgDepth: files.length > 0 ? totalDepth / files.length : 0,
    avgFilesPerDir,
    namingConsistency,
  };
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkAIReady(cwd: string): CheckResult {
  const allFiles = walkFiles(cwd);
  const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f));

  if (sourceFiles.length < 3) {
    return {
      maxScore: 100,
      name: 'aiready',
      score: 100,
      summary: 'too few source files for AI-readiness analysis',
      issues: [],
    };
  }

  const issues: Issue[] = [];

  // ── 1. Context load ───────────────────────────────────────────────────────
  const importCounts = buildImportCounts(cwd, sourceFiles);
  const counts = Array.from(importCounts.values());
  const avgContextLoad = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

  // Score: <2 = great (100), 2-4 = good (80), 4-6 = okay (60), 6-8 = poor (40), >8 = bad (20)
  const contextScore = avgContextLoad <= 2 ? 100
    : avgContextLoad <= 4 ? 100 - (avgContextLoad - 2) * 10
    : avgContextLoad <= 6 ? 80 - (avgContextLoad - 4) * 10
    : avgContextLoad <= 8 ? 60 - (avgContextLoad - 6) * 10
    : Math.max(20, 40 - (avgContextLoad - 8) * 5);

  if (avgContextLoad > 5) {
    issues.push({
      severity: 'warning',
      message: `high context load: files import ${avgContextLoad.toFixed(1)} local modules on average — AI agents need to load many files to understand changes`,
      file: '',
      fixable: true,
      fixHint: 'reduce coupling between modules, use dependency injection or barrel exports',
    });
  }

  // ── 2. Function clarity ───────────────────────────────────────────────────
  const allFuncs: FuncInfo[] = [];
  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    allFuncs.push(...extractFunctions(file, content));
  }

  const clearFuncs = allFuncs.filter(f => f.lineCount <= 25 && f.paramCount < 5);
  const clarityPct = allFuncs.length > 0 ? clearFuncs.length / allFuncs.length : 1;
  const clarityScore = Math.round(clarityPct * 100);

  const longFuncs = allFuncs.filter(f => f.lineCount > 50);
  if (longFuncs.length > 0) {
    const worst = longFuncs.sort((a, b) => b.lineCount - a.lineCount).slice(0, 3);
    issues.push({
      severity: 'warning',
      message: `${longFuncs.length} function${longFuncs.length !== 1 ? 's' : ''} >50 lines — AI agents will struggle to modify these safely. Worst: ${worst.map(f => `${f.name} (${f.lineCount} lines)`).join(', ')}`,
      file: worst[0]?.file || '',
      line: worst[0]?.line,
      fixable: true,
      fixHint: 'break into smaller, single-responsibility functions',
    });
  }

  const manyParams = allFuncs.filter(f => f.paramCount >= 5);
  if (manyParams.length > 0) {
    issues.push({
      severity: 'info',
      message: `${manyParams.length} function${manyParams.length !== 1 ? 's' : ''} with 5+ parameters — hard for agents to call correctly`,
      file: manyParams[0]?.file || '',
      fixable: true,
      fixHint: 'use an options object parameter instead',
    });
  }

  // ── 3. Type safety ────────────────────────────────────────────────────────
  const tsFiles = sourceFiles.filter(f => isTsFile(f));
  const tsRatio = sourceFiles.length > 0 ? tsFiles.length / sourceFiles.length : 0;

  // Count `any` usage in TS files
  let anyCount = 0;
  let totalTsLines = 0;
  for (const file of tsFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    const lines = content.split('\n');
    totalTsLines += lines.length;
    for (const line of lines) {
      // Match `: any`, `as any`, `<any>`, but not in comments
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      const anyMatches = line.match(/(?::\s*any\b|as\s+any\b|<any>)/g);
      if (anyMatches) anyCount += anyMatches.length;
    }
  }

  const anyDensity = totalTsLines > 0 ? anyCount / totalTsLines : 0;
  const typeSafetyScore = Math.round(tsRatio * 100 * (1 - Math.min(1, anyDensity * 50)));

  if (tsRatio < 0.5 && sourceFiles.length > 5) {
    issues.push({
      severity: 'warning',
      message: `low type coverage: ${Math.round(tsRatio * 100)}% TypeScript — AI agents can't verify their changes in untyped code`,
      file: '',
      fixable: true,
      fixHint: 'migrate JavaScript files to TypeScript incrementally',
    });
  }

  if (anyCount > 5) {
    issues.push({
      severity: 'info',
      message: `${anyCount} \`any\` type usages — weakens type safety that agents rely on`,
      file: '',
      fixable: true,
      fixHint: 'replace `any` with specific types',
    });
  }

  // ── 4. File discoverability ───────────────────────────────────────────────
  const structure = analyzeStructure(sourceFiles);

  let discoverScore = 100;
  // Penalize deep nesting
  if (structure.maxDepth > 6) discoverScore -= Math.min(20, (structure.maxDepth - 6) * 5);
  // Penalize inconsistent naming
  discoverScore -= Math.round((1 - structure.namingConsistency) * 30);
  // Penalize very large directories (>30 files)
  if (structure.avgFilesPerDir > 20) discoverScore -= Math.min(15, (structure.avgFilesPerDir - 20) * 2);
  discoverScore = Math.max(20, discoverScore);

  if (structure.namingConsistency < 0.6) {
    issues.push({
      severity: 'info',
      message: `mixed file naming conventions — AI agents work best with consistent naming (pick camelCase or kebab-case)`,
      file: '',
      fixable: true,
      fixHint: 'standardize file naming convention across the project',
    });
  }

  if (structure.maxDepth > 7) {
    issues.push({
      severity: 'info',
      message: `deeply nested file structure (max ${structure.maxDepth} levels) — agents struggle to navigate deep hierarchies`,
      file: '',
      fixable: true,
      fixHint: 'flatten directory structure where possible',
    });
  }

  // ── 5. Modification safety ────────────────────────────────────────────────
  // % of functions that are typed (in .ts files with return type)
  const typedFuncs = allFuncs.filter(f => f.isTyped && f.hasReturnType);
  const modSafetyPct = allFuncs.length > 0 ? typedFuncs.length / allFuncs.length : 0;
  const modSafetyScore = Math.round(modSafetyPct * 100);

  // ── 6. Context window fit ─────────────────────────────────────────────────
  let totalChars = 0;
  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (content) totalChars += content.length;
  }
  const estimatedTokens = totalChars / 4;
  const contextWindowSize = 128_000;
  const fitRatio = Math.min(1, contextWindowSize / estimatedTokens);

  const fitScore = fitRatio >= 1 ? 100
    : fitRatio >= 0.5 ? 70 + fitRatio * 30
    : fitRatio >= 0.25 ? 40 + fitRatio * 60
    : Math.max(10, Math.round(fitRatio * 160));

  if (fitRatio < 0.25) {
    issues.push({
      severity: 'info',
      message: `only ${Math.round(fitRatio * 100)}% of source fits in a 128k context window (${Math.round(estimatedTokens / 1000)}k tokens) — agents need careful file selection`,
      file: '',
      fixable: false,
      fixHint: 'maintain clear module boundaries so agents can work on isolated sections',
    });
  }

  // ── Weighted score ────────────────────────────────────────────────────────
  const score = Math.max(25, Math.round(
    contextScore * 0.25 +
    clarityScore * 0.20 +
    typeSafetyScore * 0.20 +
    discoverScore * 0.15 +
    modSafetyScore * 0.10 +
    fitScore * 0.10
  ));

  // ── Summary ───────────────────────────────────────────────────────────────
  const parts: string[] = [];
  parts.push(`context load ${avgContextLoad.toFixed(1)} files`);
  parts.push(`${Math.round(clarityPct * 100)}% clear functions`);
  parts.push(`${Math.round(tsRatio * 100)}% typed`);
  if (fitRatio < 0.5) parts.push(c.yellow + `${Math.round(fitRatio * 100)}% fits in 128k` + c.reset);
  if (longFuncs.length > 0) parts.push(c.yellow + `${longFuncs.length} long functions` + c.reset);

  return {
      maxScore: 100,
    name: 'aiready',
    score,
    summary: parts.join(', '),
    issues,
  };
}
