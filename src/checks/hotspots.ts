import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { walkFiles, readFile, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.py', '.go', '.rs', '.java']);

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTS.has(f.substring(dot));
}

// ── Git log analysis ────────────────────────────────────────────────────────

interface FileChurn {
  file: string;
  commits: number;
  authors: number;
  linesChanged: number;
}

interface TemporalCoupling {
  file1: string;
  file2: string;
  cochanges: number;
  /** coupled / min(commits_a, commits_b) */
  couplingStrength: number;
}

function getGitChurn(cwd: string, months = 6): Map<string, FileChurn> {
  const churn = new Map<string, FileChurn>();

  try {
    const since = `--since="${months} months ago"`;
    // Get commit count + authors per file
    const log = execSync(
      `git log ${since} --format="%H %ae" --name-only --no-merges 2>/dev/null`,
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 15_000 },
    );

    let currentAuthor = '';
    const fileAuthors = new Map<string, Set<string>>();
    const fileCommits = new Map<string, number>();

    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      if (/^[0-9a-f]{40}\s/.test(line)) {
        currentAuthor = line.split(' ').slice(1).join(' ');
        continue;
      }
      const file = line.trim();
      fileCommits.set(file, (fileCommits.get(file) || 0) + 1);
      if (!fileAuthors.has(file)) fileAuthors.set(file, new Set());
      fileAuthors.get(file)!.add(currentAuthor);
    }

    // Get lines changed per file
    const numstat = execSync(
      `git log ${since} --numstat --format="" --no-merges 2>/dev/null`,
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 15_000 },
    );

    const fileLinesChanged = new Map<string, number>();
    for (const line of numstat.split('\n')) {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const added = parseInt(match[1], 10);
      const removed = parseInt(match[2], 10);
      const file = match[3];
      fileLinesChanged.set(file, (fileLinesChanged.get(file) || 0) + added + removed);
    }

    for (const [file, commits] of fileCommits) {
      churn.set(file, {
        file,
        commits,
        authors: fileAuthors.get(file)?.size || 1,
        linesChanged: fileLinesChanged.get(file) || 0,
      });
    }
  } catch {
    // Not a git repo or git not available
  }

  return churn;
}

function getTemporalCoupling(cwd: string, months = 6): TemporalCoupling[] {
  const couplings: TemporalCoupling[] = [];

  try {
    const since = `--since="${months} months ago"`;
    const log = execSync(
      `git log ${since} --format="COMMIT" --name-only --no-merges 2>/dev/null`,
      { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 15_000 },
    );

    // Parse commits into file sets
    const commits: string[][] = [];
    let current: string[] = [];
    for (const line of log.split('\n')) {
      if (line === 'COMMIT') {
        if (current.length > 0) commits.push(current);
        current = [];
      } else if (line.trim()) {
        const f = line.trim();
        if (isSourceFile(f)) current.push(f);
      }
    }
    if (current.length > 0) commits.push(current);

    // Count co-changes (files that appear in same commit)
    const pairCount = new Map<string, number>();
    const fileCommitCount = new Map<string, number>();

    for (const files of commits) {
      if (files.length > 20) continue; // skip huge commits (refactors/renames)
      for (const f of files) {
        fileCommitCount.set(f, (fileCommitCount.get(f) || 0) + 1);
      }
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = [files[i], files[j]].sort().join('::');
          pairCount.set(key, (pairCount.get(key) || 0) + 1);
        }
      }
    }

    // Find strong couplings
    for (const [key, count] of pairCount) {
      if (count < 3) continue; // minimum 3 co-changes
      const [f1, f2] = key.split('::');
      const minCommits = Math.min(
        fileCommitCount.get(f1) || 1,
        fileCommitCount.get(f2) || 1,
      );
      const strength = count / minCommits;
      if (strength > 0.5) { // >50% of the time they change together
        couplings.push({ file1: f1, file2: f2, cochanges: count, couplingStrength: strength });
      }
    }

    couplings.sort((a, b) => b.couplingStrength - a.couplingStrength);
  } catch {
    // Not a git repo
  }

  return couplings;
}

// ── Complexity proxy: indentation depth ─────────────────────────────────────

function getIndentationComplexity(content: string): number {
  const lines = content.split('\n');
  let totalDepth = 0;
  let maxDepth = 0;
  let measured = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^(\s+)/);
    if (match) {
      const depth = match[1].includes('\t')
        ? match[1].split('\t').length - 1
        : Math.floor(match[1].length / 2);
      totalDepth += depth;
      if (depth > maxDepth) maxDepth = depth;
    }
    measured++;
  }

  return measured > 0 ? totalDepth / measured : 0;
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkHotspots(cwd: string): Promise<CheckResult> {
  const issues: Issue[] = [];
  const t0 = Date.now();

  const churn = getGitChurn(cwd);
  if (churn.size === 0) {
    return { name: 'hotspots', score: 100, maxScore: 100, summary: 'no git history', issues: [] };
  }

  const allFiles = walkFiles(cwd);
  const sourceFiles = allFiles.filter(f => isSourceFile(f));

  // Calculate complexity for each file (indentation-based, fast)
  const fileComplexity = new Map<string, number>();
  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;
    fileComplexity.set(file, getIndentationComplexity(content));
  }

  // ── Hotspot analysis: churn × complexity ──────────────────────────────────
  interface Hotspot {
    file: string;
    commits: number;
    complexity: number;
    risk: number;
    authors: number;
  }

  const hotspots: Hotspot[] = [];
  for (const [file, ch] of churn) {
    const complexity = fileComplexity.get(file);
    if (complexity === undefined) continue;
    // Normalize: risk = log(commits) × complexity
    const risk = Math.log2(ch.commits + 1) * complexity;
    hotspots.push({ file, commits: ch.commits, complexity, risk, authors: ch.authors });
  }

  hotspots.sort((a, b) => b.risk - a.risk);

  // Top hotspots are issues
  const topHotspots = hotspots.slice(0, 5);
  for (const hs of topHotspots) {
    if (hs.risk < 5) continue; // skip low-risk files
    issues.push({
      severity: hs.risk > 20 ? 'warning' : 'info',
      message: `hotspot: ${hs.file} — ${hs.commits} commits, complexity ${hs.complexity.toFixed(1)}, risk score ${hs.risk.toFixed(1)}${hs.authors > 3 ? `, ${hs.authors} authors` : ''}`,
      file: hs.file,
      fixable: false,
      fixHint: 'high-churn complex files are bug magnets — prioritize refactoring and add tests',
    });
  }

  // ── Temporal coupling ─────────────────────────────────────────────────────
  const couplings = getTemporalCoupling(cwd);

  // Filter out obvious couplings (same directory, test+source)
  const interestingCouplings = couplings.filter(cp => {
    const dir1 = cp.file1.split('/').slice(0, -1).join('/');
    const dir2 = cp.file2.split('/').slice(0, -1).join('/');
    // Same directory coupling is expected
    if (dir1 === dir2) return false;
    // Test+source coupling is expected
    if (cp.file1.includes('test') || cp.file2.includes('test')) return false;
    return true;
  });

  for (const cp of interestingCouplings.slice(0, 3)) {
    issues.push({
      severity: 'info',
      message: `temporal coupling: ${cp.file1} ↔ ${cp.file2} change together ${Math.round(cp.couplingStrength * 100)}% of the time (${cp.cochanges} co-changes) — possible hidden dependency`,
      file: cp.file1,
      fixable: false,
      fixHint: 'investigate if these files share a concept that should be co-located or abstracted',
    });
  }

  // ── Multi-author hotfiles ─────────────────────────────────────────────────
  const manyAuthors = hotspots.filter(h => h.authors >= 5).slice(0, 3);
  for (const ma of manyAuthors) {
    issues.push({
      severity: 'info',
      message: `knowledge diffusion: ${ma.file} touched by ${ma.authors} authors — high bus factor risk if not well-documented`,
      file: ma.file,
      fixable: false,
      fixHint: 'ensure this file has clear documentation and tests — many people modify it',
    });
  }

  const elapsed = Date.now() - t0;

  // ── Scoring ───────────────────────────────────────────────────────────────
  // Score based on how many high-risk hotspots exist relative to codebase size
  const highRiskCount = hotspots.filter(h => h.risk > 20).length;
  const riskRatio = sourceFiles.length > 0 ? highRiskCount / sourceFiles.length : 0;
  const hotspotScore = Math.max(25, Math.round(100 - riskRatio * 500));

  // Temporal coupling penalty
  const couplingPenalty = Math.min(30, interestingCouplings.length * 5);

  const score = Math.max(25, hotspotScore - couplingPenalty);

  const parts: string[] = [];
  parts.push(`${churn.size} files in git history, ${elapsed}ms`);
  if (topHotspots.length > 0 && topHotspots[0].risk > 5) {
    parts.push(c.yellow + `top hotspot: ${topHotspots[0].file.split('/').pop()} (risk ${topHotspots[0].risk.toFixed(0)})` + c.reset);
  }
  if (interestingCouplings.length > 0) {
    parts.push(`${interestingCouplings.length} temporal couplings`);
  }

  return { name: 'hotspots', score, maxScore: 100, summary: parts.join(', '), issues };
}
