import { join } from 'node:path';
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

// ── Anti-pattern definitions ────────────────────────────────────────────────

interface AntiPattern {
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  fixHint: string;
  /** Natural language description for embedding */
  embedding_text: string;
}

const ANTI_PATTERNS: AntiPattern[] = [
  {
    name: 'lazy-error-handling',
    description: 'catches error but only logs it without recovery or rethrow',
    severity: 'warning',
    fixHint: 'add proper error recovery, rethrow with context, or use typed error classes',
    embedding_text: 'try { doSomething(); } catch(e) { console.log(e); } try { await fetch(url); } catch(err) { console.error(err); return null; }',
  },
  {
    name: 'any-abuse',
    description: 'excessive use of TypeScript any type to bypass type checking',
    severity: 'warning',
    fixHint: 'replace any with specific types, use unknown for truly unknown types',
    embedding_text: 'function process(data: any, config: any): any { return (data as any).map((x: any) => x); const result: any = {}; }',
  },
  {
    name: 'callback-hell',
    description: 'deeply nested callbacks or promise chains',
    severity: 'info',
    fixHint: 'refactor to async/await',
    embedding_text: 'getData(function(a) { getMore(a, function(b) { getEvenMore(b, function(c) { process(c, function(d) { done(d); }); }); }); });',
  },
  {
    name: 'empty-function',
    description: 'function with no implementation or only comments/todos',
    severity: 'warning',
    fixHint: 'implement the function or remove it',
    embedding_text: 'function handleSubmit() { /* TODO: implement */ } function processData(input) { // not implemented yet return input; }',
  },
  {
    name: 'string-heavy-logic',
    description: 'business logic driven by string comparisons instead of enums or types',
    severity: 'info',
    fixHint: 'use enums, union types, or constants instead of string literals',
    embedding_text: 'if (status === "pending") { } else if (status === "active") { } else if (status === "cancelled") { } else if (status === "completed") { }',
  },
];

// ── Function extraction ─────────────────────────────────────────────────────

interface FuncSnippet {
  name: string;
  file: string;
  line: number;
  body: string;
}

function extractFunctions(file: string, content: string): FuncSnippet[] {
  const funcs: FuncSnippet[] = [];
  const lines = content.split('\n');

  const funcStartRe = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
  const arrowRe = /^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/;
  const methodRe = /^\s+(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(funcStartRe) || line.match(arrowRe) || line.match(methodRe);
    if (!match) continue;
    const name = match[1];
    if (!name || ['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue;

    // Find end of function
    let depth = 0, started = false, endLine = i;
    for (let j = i; j < lines.length && j < i + 200; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }
      if (started && depth <= 0) { endLine = j; break; }
    }

    const lineCount = endLine - i + 1;
    if (lineCount < 8) continue; // skip tiny functions

    const body = lines.slice(i, endLine + 1).join('\n').slice(0, 400);
    funcs.push({ name, file, line: i + 1, body });
  }

  return funcs;
}

// ── Cosine similarity ───────────────────────────────────────────────────────

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a as any)[i] * (b as any)[i];
    na += (a as any)[i] * (a as any)[i];
    nb += (b as any)[i] * (b as any)[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkSemantic(cwd: string): Promise<CheckResult> {
  const allFiles = walkFiles(cwd);
  const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f));

  if (sourceFiles.length < 3) {
    return { name: 'semantic', score: 100, maxScore: 100, summary: 'too few files', issues: [] };
  }

  // Extract functions
  const allFuncs: FuncSnippet[] = [];
  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    allFuncs.push(...extractFunctions(file, content));
  }

  if (allFuncs.length === 0) {
    return { name: 'semantic', score: 100, maxScore: 100, summary: 'no functions', issues: [] };
  }

  // Cap at 100 longest functions for performance
  const funcsToAnalyze = allFuncs
    .sort((a, b) => b.body.length - a.body.length)
    .slice(0, 100);

  const issues: Issue[] = [];
  const t0 = Date.now();
  let matchCount = 0;

  try {
    const { pipeline } = await import('@huggingface/transformers');
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
    });

    // Embed anti-patterns once
    const patternEmbeddings: { pattern: AntiPattern; embedding: Float32Array }[] = [];
    for (const pattern of ANTI_PATTERNS) {
      const result = await extractor(pattern.embedding_text, { pooling: 'mean', normalize: true });
      patternEmbeddings.push({ pattern, embedding: new Float32Array(result.data as Float64Array) });
    }

    // Embed and compare each function
    const THRESHOLD = 0.45; // similarity threshold — code-to-code embeddings (0.40 gave false positives)

    for (const func of funcsToAnalyze) {
      const result = await extractor(func.body, { pooling: 'mean', normalize: true });
      const funcEmb = new Float32Array(result.data as Float64Array);

      for (const { pattern, embedding } of patternEmbeddings) {
        const sim = cosine(funcEmb, embedding);
        if (sim > THRESHOLD) {
          matchCount++;
          issues.push({
            severity: pattern.severity,
            message: `semantic match: ${func.name} matches "${pattern.name}" pattern (${Math.round(sim * 100)}% similarity) — ${pattern.description}`,
            file: func.file,
            line: func.line,
            fixable: true,
            fixHint: pattern.fixHint,
          });
          break; // one match per function
        }
      }
    }
  } catch (err) {
    // transformers.js not available or model download failed
    return {
      name: 'semantic',
      score: 100,
      maxScore: 100,
      summary: `semantic analysis unavailable: ${err instanceof Error ? err.message : 'unknown'}`,
      issues: [],
    };
  }

  const elapsed = Date.now() - t0;

  // Score based on % of functions matching anti-patterns
  const matchRate = funcsToAnalyze.length > 0 ? matchCount / funcsToAnalyze.length : 0;
  const score = Math.max(25, Math.round(100 - matchRate * 200));

  const parts: string[] = [];
  parts.push(`${funcsToAnalyze.length} functions scanned in ${elapsed}ms`);
  if (matchCount > 0) parts.push(c.yellow + `${matchCount} anti-pattern matches` + c.reset);
  else parts.push('no anti-patterns detected');

  return {
    name: 'semantic',
    score,
    maxScore: 100,
    summary: parts.join(', '),
    issues,
  };
}
