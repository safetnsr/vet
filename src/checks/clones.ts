import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

function isExampleFile(f: string): boolean {
  return /(?:^|[/\\])(?:examples?|templates?|fixtures?|demos?)[/\\]/.test(f);
}

// ── Token normalization ─────────────────────────────────────────────────────
// Strip comments, normalize whitespace, replace identifiers with placeholders
// This makes structurally identical code match even with different variable names

function normalizeTokens(code: string): string {
  // Remove single-line comments
  let normalized = code.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove string literals (replace with placeholder)
  normalized = normalized.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '"S"');
  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();
  // Normalize numbers (replace with placeholder)
  normalized = normalized.replace(/\b\d+\.?\d*\b/g, '0');
  return normalized;
}

// ── Rolling hash (Rabin-Karp style) for chunk detection ─────────────────────

interface CodeChunk {
  file: string;
  startLine: number;
  endLine: number;
  hash: string;
  raw: string;
}

const MIN_CHUNK_LINES = 6; // minimum lines for a clone to matter

function extractChunks(file: string, content: string, windowSize: number): CodeChunk[] {
  const lines = content.split('\n');
  const chunks: CodeChunk[] = [];

  for (let i = 0; i <= lines.length - windowSize; i++) {
    const rawSlice = lines.slice(i, i + windowSize);
    // Skip chunks that are mostly empty or imports
    const meaningful = rawSlice.filter(l => {
      const t = l.trim();
      return t && !t.startsWith('import ') && !t.startsWith('export ') && t !== '{' && t !== '}' && t !== ');';
    });
    if (meaningful.length < windowSize * 0.5) continue;

    const normalized = normalizeTokens(rawSlice.join('\n'));
    if (normalized.length < 40) continue; // too short after normalization

    const hash = createHash('md5').update(normalized).digest('hex');
    chunks.push({
      file,
      startLine: i + 1,
      endLine: i + windowSize,
      hash,
      raw: rawSlice.join('\n'),
    });
  }

  return chunks;
}

// ── Clone detection ─────────────────────────────────────────────────────────

interface CloneGroup {
  hash: string;
  locations: { file: string; startLine: number; endLine: number }[];
  lineCount: number;
  sample: string;
}

export async function checkClones(cwd: string): Promise<CheckResult> {
  const allFiles = walkFiles(cwd);
  const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f) && !isExampleFile(f));

  if (sourceFiles.length < 2) {
    return { name: 'clones', score: 100, maxScore: 100, summary: 'too few files', issues: [] };
  }

  const t0 = Date.now();
  const issues: Issue[] = [];

  // Single window size — use the largest to reduce noise
  const WINDOW_SIZE = 10;
  const hashMap = new Map<string, CodeChunk[]>();

  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;

    const chunks = extractChunks(file, content, WINDOW_SIZE);
    for (const chunk of chunks) {
      if (!hashMap.has(chunk.hash)) hashMap.set(chunk.hash, []);
      hashMap.get(chunk.hash)!.push(chunk);
    }
  }

  // Find cross-file duplicates, pick ONE representative per file per clone
  const allCloneGroups: CloneGroup[] = [];

  for (const [hash, chunks] of hashMap) {
    if (chunks.length < 2) continue;

    // Group by file, pick earliest occurrence per file
    const byFile = new Map<string, CodeChunk>();
    for (const chunk of chunks) {
      const existing = byFile.get(chunk.file);
      if (!existing || chunk.startLine < existing.startLine) {
        byFile.set(chunk.file, chunk);
      }
    }

    // Cross-file only
    if (byFile.size < 2) continue;

    const reps = [...byFile.values()];
    allCloneGroups.push({
      hash,
      locations: reps.map(r => ({ file: r.file, startLine: r.startLine, endLine: r.endLine })),
      lineCount: WINDOW_SIZE,
      sample: reps[0].raw.slice(0, 200),
    });
  }

  // Deduplicate overlapping clones: group by file-set, merge overlapping line ranges
  // Sort by number of files (more widespread clones first), then by earliest line
  allCloneGroups.sort((a, b) => b.locations.length - a.locations.length || a.locations[0].startLine - b.locations[0].startLine);

  const coveredRanges = new Map<string, Set<number>>();
  const filteredGroups: CloneGroup[] = [];

  for (const group of allCloneGroups) {
    // Check if the first location is already substantially covered
    const firstLoc = group.locations[0];
    const covered = coveredRanges.get(firstLoc.file);
    if (covered) {
      let overlapCount = 0;
      for (let line = firstLoc.startLine; line <= firstLoc.endLine; line++) {
        if (covered.has(line)) overlapCount++;
      }
      // Skip if >50% of lines already reported
      if (overlapCount > group.lineCount * 0.5) continue;
    }

    filteredGroups.push(group);

    // Mark all locations as covered
    for (const loc of group.locations) {
      if (!coveredRanges.has(loc.file)) coveredRanges.set(loc.file, new Set());
      const set = coveredRanges.get(loc.file)!;
      for (let line = loc.startLine; line <= loc.endLine; line++) {
        set.add(line);
      }
    }
  }

  // Report top clones
  const topClones = filteredGroups.slice(0, 10);
  for (const clone of topClones) {
    const locs = clone.locations.slice(0, 3);
    const locStr = locs.map(l => `${l.file}:${l.startLine}`).join(', ');
    issues.push({
      severity: clone.lineCount >= 15 ? 'warning' : 'info',
      message: `duplicated ${clone.lineCount}-line block across ${clone.locations.length} files: ${locStr}`,
      file: clone.locations[0].file,
      line: clone.locations[0].startLine,
      fixable: true,
      fixHint: 'extract into a shared function or module',
    });
  }

  const elapsed = Date.now() - t0;

  // ── Scoring ───────────────────────────────────────────────────────────────
  // Total duplicated lines as % of codebase
  const totalSourceLines = sourceFiles.reduce((sum, f) => {
    const content = readFile(join(cwd, f));
    return sum + (content ? content.split('\n').length : 0);
  }, 0);

  // Count unique duplicated lines from covered ranges
  let duplicatedLines = 0;
  for (const lines of coveredRanges.values()) {
    duplicatedLines += lines.size;
  }
  const duplicationRate = totalSourceLines > 0 ? duplicatedLines / totalSourceLines : 0;

  const score = Math.max(25, Math.round(100 - duplicationRate * 400));

  const parts: string[] = [];
  parts.push(`${sourceFiles.length} files scanned in ${elapsed}ms`);
  if (filteredGroups.length > 0) {
    parts.push(c.yellow + `${filteredGroups.length} clone groups` + c.reset);
    parts.push(`${duplicatedLines} duplicated lines (${(duplicationRate * 100).toFixed(1)}%)`);
  } else {
    parts.push('no cross-file clones detected');
  }

  return { name: 'clones', score, maxScore: 100, summary: parts.join(', '), issues };
}
