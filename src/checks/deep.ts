import { join } from 'node:path';
import ts from 'typescript';
import { walkFiles, readFile, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTS.has(f.substring(dot));
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__') || /(?:^|[/\\])tests?[/\\]/.test(f);
}

// ── AST-based function analysis ─────────────────────────────────────────────

const BRANCHING_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.BinaryExpression, // for && and || short-circuits
]);

interface FuncMetrics {
  name: string;
  file: string;
  line: number;
  lineCount: number;
  paramCount: number;
  cyclomatic: number;
  maxNesting: number;
  hasReturnType: boolean;
  catchBlocks: CatchInfo[];
  cognitiveComplexity: number;
}

interface CatchInfo {
  line: number;
  isEmpty: boolean;
  isLazy: boolean; // only console.log/console.error
  isRethrow: boolean;
}

function analyzeCatch(node: ts.CatchClause): CatchInfo {
  const block = node.block;
  const stmts = block.statements;
  const line = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

  if (stmts.length === 0) {
    return { line, isEmpty: true, isLazy: false, isRethrow: false };
  }

  const text = block.getText();
  const isLazy = stmts.length === 1 && /console\.(log|error|warn)\s*\(/.test(text) && !text.includes('throw');
  const isRethrow = text.includes('throw');

  return { line, isEmpty: false, isLazy, isRethrow };
}

function analyzeFunction(node: ts.Node, file: string, src: ts.SourceFile): FuncMetrics | null {
  let name = '';
  let paramCount = 0;
  let hasReturnType = false;
  let body: ts.Node | undefined;

  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    name = node.name?.getText(src) || '(anonymous)';
    paramCount = node.parameters.length;
    hasReturnType = !!node.type;
    body = node.body;
  } else if (ts.isMethodDeclaration(node)) {
    name = node.name?.getText(src) || '(method)';
    paramCount = node.parameters.length;
    hasReturnType = !!node.type;
    body = node.body;
  } else if (ts.isArrowFunction(node)) {
    // Get name from parent variable declaration
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name) {
      name = parent.name.getText(src);
    } else {
      name = '(arrow)';
    }
    paramCount = node.parameters.length;
    hasReturnType = !!node.type;
    body = node.body;
  }

  if (!body || !name) return null;

  const startLine = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const endLine = src.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const lineCount = endLine - startLine + 1;

  if (lineCount < 5) return null; // skip trivial functions

  // Calculate cyclomatic complexity + max nesting + catch quality
  let cyclomatic = 1;
  let maxNesting = 0;
  let currentNesting = 0;
  let cognitive = 0;
  const catchBlocks: CatchInfo[] = [];

  function walk(n: ts.Node, nesting: number) {
    if (BRANCHING_KINDS.has(n.kind)) {
      // Don't count && and || as branching for cyclomatic (too noisy)
      if (n.kind === ts.SyntaxKind.BinaryExpression) {
        const binExpr = n as ts.BinaryExpression;
        if (binExpr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            binExpr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          cyclomatic++;
          cognitive += 1; // no nesting increment for logical ops
        }
      } else {
        cyclomatic++;
        currentNesting = nesting + 1;
        if (currentNesting > maxNesting) maxNesting = currentNesting;
        cognitive += 1 + nesting; // cognitive complexity: increment + nesting bonus
      }
    }

    if (ts.isCatchClause(n)) {
      catchBlocks.push(analyzeCatch(n));
    }

    const nextNesting = BRANCHING_KINDS.has(n.kind) && n.kind !== ts.SyntaxKind.BinaryExpression
      ? nesting + 1 : nesting;
    ts.forEachChild(n, child => walk(child, nextNesting));
  }

  walk(body, 0);

  return {
    name, file, line: startLine, lineCount, paramCount,
    cyclomatic, maxNesting, hasReturnType, catchBlocks,
    cognitiveComplexity: cognitive,
  };
}

// ── Naming analysis (heuristic, no ML) ──────────────────────────────────────

function isDescriptiveName(name: string): 'good' | 'unclear' | 'too-short' {
  if (name.startsWith('(')) return 'unclear'; // anonymous
  if (name.length <= 2) return 'too-short';
  // Single word with no verb pattern
  if (!/[A-Z]/.test(name) && !name.includes('_') && name.length < 6) return 'too-short';
  return 'good';
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkDeep(cwd: string): Promise<CheckResult> {
  const allFiles = walkFiles(cwd);
  const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f));

  if (sourceFiles.length < 3) {
    return { name: 'deep', score: 100, maxScore: 100, summary: 'too few files', issues: [] };
  }

  const issues: Issue[] = [];
  const allMetrics: FuncMetrics[] = [];
  const t0 = Date.now();

  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;

    try {
      const src = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);

      function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
            ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
          const metrics = analyzeFunction(node, file, src);
          if (metrics) allMetrics.push(metrics);
        }
        ts.forEachChild(node, visit);
      }
      visit(src);
    } catch {
      // Skip files that can't be parsed
    }
  }

  const elapsed = Date.now() - t0;

  if (allMetrics.length === 0) {
    return { name: 'deep', score: 100, maxScore: 100, summary: 'no functions to analyze', issues: [] };
  }

  // ── Cyclomatic complexity ─────────────────────────────────────────────────
  const highComplexity = allMetrics.filter(f => f.cyclomatic > 10);
  const veryHighComplexity = allMetrics.filter(f => f.cyclomatic > 20);

  for (const func of veryHighComplexity.slice(0, 5)) {
    issues.push({
      severity: 'warning',
      message: `high cyclomatic complexity: ${func.name} has complexity ${func.cyclomatic} (threshold: 10) — hard to test and modify`,
      file: func.file, line: func.line,
      fixable: true,
      fixHint: 'break into smaller functions, use strategy pattern or lookup tables',
    });
  }

  for (const func of highComplexity.filter(f => f.cyclomatic <= 20).slice(0, 5)) {
    issues.push({
      severity: 'info',
      message: `moderate complexity: ${func.name} has complexity ${func.cyclomatic} (threshold: 10)`,
      file: func.file, line: func.line,
      fixable: true,
      fixHint: 'consider extracting helper functions',
    });
  }

  // ── Deep nesting ──────────────────────────────────────────────────────────
  const deeplyNested = allMetrics.filter(f => f.maxNesting > 4);
  for (const func of deeplyNested.slice(0, 5)) {
    issues.push({
      severity: 'warning',
      message: `deep nesting: ${func.name} has ${func.maxNesting} levels of nesting — use early returns or extract functions`,
      file: func.file, line: func.line,
      fixable: true,
      fixHint: 'use guard clauses (early return) to flatten nesting',
    });
  }

  // ── Catch block quality ───────────────────────────────────────────────────
  const allCatches = allMetrics.flatMap(f => f.catchBlocks.map(cb => ({ ...cb, func: f })));
  const emptyCatches = allCatches.filter(c => c.isEmpty);
  const lazyCatches = allCatches.filter(c => c.isLazy);

  for (const ec of emptyCatches.slice(0, 3)) {
    issues.push({
      severity: 'error',
      message: `empty catch block in ${ec.func.name} — errors are silently swallowed`,
      file: ec.func.file, line: ec.line,
      fixable: true,
      fixHint: 'at minimum: log the error, or re-throw with context',
    });
  }

  for (const lc of lazyCatches.slice(0, 3)) {
    issues.push({
      severity: 'warning',
      message: `lazy error handling in ${lc.func.name} — catch only console.logs the error without recovery or rethrow`,
      file: lc.func.file, line: lc.line,
      fixable: true,
      fixHint: 'add proper error handling: typed errors, retry logic, or graceful degradation',
    });
  }

  // ── Cognitive complexity ──────────────────────────────────────────────────
  const highCognitive = allMetrics.filter(f => f.cognitiveComplexity > 15);
  for (const func of highCognitive.slice(0, 3)) {
    issues.push({
      severity: 'info',
      message: `high cognitive complexity: ${func.name} has cognitive complexity ${func.cognitiveComplexity} — difficult for humans and AI agents to understand`,
      file: func.file, line: func.line,
      fixable: true,
      fixHint: 'simplify control flow, extract well-named helper functions',
    });
  }

  // ── Parameter count ───────────────────────────────────────────────────────
  const manyParams = allMetrics.filter(f => f.paramCount >= 5);
  if (manyParams.length > 0) {
    issues.push({
      severity: 'info',
      message: `${manyParams.length} function${manyParams.length !== 1 ? 's' : ''} with 5+ parameters: ${manyParams.slice(0, 3).map(f => f.name + '(' + f.paramCount + ')').join(', ')}`,
      file: manyParams[0].file, line: manyParams[0].line,
      fixable: true,
      fixHint: 'use an options object instead of many positional parameters',
    });
  }

  // ── Naming quality ────────────────────────────────────────────────────────
  const poorNames = allMetrics.filter(f => isDescriptiveName(f.name) !== 'good');
  if (poorNames.length > 3) {
    issues.push({
      severity: 'info',
      message: `${poorNames.length} functions with unclear or too-short names: ${poorNames.slice(0, 3).map(f => '"' + f.name + '"').join(', ')}`,
      file: poorNames[0].file,
      fixable: true,
      fixHint: 'use descriptive verb+noun function names (e.g., calculateTotal, validateUser)',
    });
  }

  // ── Scoring ───────────────────────────────────────────────────────────────
  const total = allMetrics.length;

  // Complexity score: % of functions below threshold
  const complexityOk = allMetrics.filter(f => f.cyclomatic <= 10).length;
  const complexityScore = Math.round((complexityOk / total) * 100);

  // Nesting score
  const nestingOk = allMetrics.filter(f => f.maxNesting <= 4).length;
  const nestingScore = Math.round((nestingOk / total) * 100);

  // Error handling score
  const errorScore = allCatches.length === 0 ? 100
    : Math.max(20, 100 - emptyCatches.length * 20 - lazyCatches.length * 10);

  // Naming score
  const namingOk = allMetrics.filter(f => isDescriptiveName(f.name) === 'good').length;
  const namingScore = Math.round((namingOk / total) * 100);

  const score = Math.max(25, Math.round(
    complexityScore * 0.35 +
    nestingScore * 0.25 +
    errorScore * 0.25 +
    namingScore * 0.15
  ));

  // ── Summary ───────────────────────────────────────────────────────────────
  const parts: string[] = [];
  parts.push(`${total} functions analyzed in ${elapsed}ms`);
  if (highComplexity.length > 0) parts.push(c.yellow + `${highComplexity.length} complex` + c.reset);
  if (deeplyNested.length > 0) parts.push(c.yellow + `${deeplyNested.length} deeply nested` + c.reset);
  if (emptyCatches.length > 0) parts.push(c.red + `${emptyCatches.length} empty catches` + c.reset);
  if (lazyCatches.length > 0) parts.push(c.yellow + `${lazyCatches.length} lazy catches` + c.reset);

  return { name: 'deep', score, maxScore: 100, summary: parts.join(', '), issues };
}
