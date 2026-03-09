import { join, extname } from 'node:path';
import { statSync } from 'node:fs';
import { walkFiles, readFile, gitExec, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const AI_PATTERNS = /\b(claude|copilot|ai|agent)\b|\[(claude|ai)\]/i;
const AI_FILE_MARKERS = ['.claude/', 'CLAUDE.md', 'AGENTS.md'];
const NON_CODE_EXTS = new Set(['.txt', '.log', '.csv', '.json']);
const SOURCE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx']);
const TEN_MB = 10 * 1024 * 1024;
const BRANCH_RE = /\b(if|else|switch|case)\b|&&|\|\||\?[^?.:]/g;

// ── Baseline detection ───────────────────────────────────────────────────────

function findBaseline(cwd: string): { sha: string; message: string; method: string } {
  // 1. Search git log for AI-pattern commits
  const log = gitExec(['log', '--oneline', '--all', '--reverse'], cwd);
  if (!log) {
    return { sha: '', message: '', method: 'empty' };
  }

  const lines = log.split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { sha: '', message: '', method: 'empty' };
  }

  for (const line of lines) {
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const msg = line.substring(spaceIdx + 1);
    if (AI_PATTERNS.test(msg)) {
      const sha = line.substring(0, spaceIdx);
      // Use parent of this commit as baseline (the commit before AI started)
      const parent = gitExec(['rev-parse', `${sha}~1`], cwd);
      if (parent) {
        const parentMsg = gitExec(['log', '--oneline', '-1', parent], cwd);
        return { sha: parent, message: parentMsg.substring(parentMsg.indexOf(' ') + 1) || parent, method: 'ai-commit-parent' };
      }
      // If no parent (first commit is AI), use this commit itself
      return { sha, message: msg, method: 'ai-commit' };
    }
  }

  // 2. Fallback: find first commit adding AI marker files
  for (const marker of AI_FILE_MARKERS) {
    const result = gitExec(['log', '--all', '--reverse', '--diff-filter=A', '--', marker], cwd);
    if (result) {
      const firstLine = result.split('\n').find(l => l.startsWith('commit '));
      if (firstLine) {
        const sha = firstLine.replace('commit ', '').trim();
        const shortSha = sha.substring(0, 7);
        const parent = gitExec(['rev-parse', `${sha}~1`], cwd);
        if (parent) {
          const parentLog = gitExec(['log', '--oneline', '-1', parent], cwd);
          return { sha: parent, message: parentLog.substring(parentLog.indexOf(' ') + 1) || parent, method: 'marker-file' };
        }
      }
    }
  }

  // 3. Fallback: initial commit (everything is baseline)
  const initial = lines[0];
  const spaceIdx = initial.indexOf(' ');
  const sha = spaceIdx !== -1 ? initial.substring(0, spaceIdx) : initial;
  const msg = spaceIdx !== -1 ? initial.substring(spaceIdx + 1) : sha;
  return { sha, message: msg, method: 'initial' };
}

// ── Per-file bloat analysis ──────────────────────────────────────────────────

interface FileGrowth {
  file: string;
  additions: number;
  deletions: number;
  baselineLines: number;
  currentLines: number;
  growthPct: number;
  isNew: boolean;
}

function analyzeFileGrowth(cwd: string, baselineSha: string): { files: FileGrowth[]; baselineLOC: number; currentLOC: number } {
  if (!baselineSha) {
    return { files: [], baselineLOC: 0, currentLOC: 0 };
  }

  const numstat = gitExec(['diff', baselineSha, 'HEAD', '--numstat'], cwd);
  if (!numstat) {
    return { files: [], baselineLOC: 0, currentLOC: 0 };
  }

  const files: FileGrowth[] = [];
  let totalBaselineLOC = 0;
  let totalCurrentLOC = 0;

  for (const line of numstat.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addStr, delStr, file] = parts;

    // Binary files show as '-'
    if (addStr === '-' || delStr === '-') continue;

    const additions = parseInt(addStr, 10) || 0;
    const deletions = parseInt(delStr, 10) || 0;

    // Get baseline line count for this file
    const baselineContent = gitExec(['show', `${baselineSha}:${file}`], cwd);
    const baselineLines = baselineContent ? baselineContent.split('\n').length : 0;
    const isNew = baselineLines === 0;
    const currentLines = Math.max(0, baselineLines + additions - deletions);

    const denominator = Math.max(baselineLines, 1);
    const growthPct = ((currentLines / denominator) - 1) * 100;

    totalBaselineLOC += baselineLines;
    totalCurrentLOC += currentLines;

    files.push({ file, additions, deletions, baselineLines, currentLines, growthPct, isNew });
  }

  // If baseline LOC is 0 but we have current LOC, count all current files
  if (totalBaselineLOC === 0) {
    // Count current LOC from all tracked files
    const lsFiles = gitExec(['ls-files'], cwd);
    if (lsFiles) {
      for (const f of lsFiles.split('\n').filter(Boolean)) {
        const content = readFile(join(cwd, f));
        if (content) totalCurrentLOC += content.split('\n').length;
      }
    }
  }

  return { files, baselineLOC: totalBaselineLOC, currentLOC: totalCurrentLOC };
}

// ── Non-code bombs ───────────────────────────────────────────────────────────

interface NonCodeBomb {
  file: string;
  sizeBytes: number;
}

function findNonCodeBombs(cwd: string): NonCodeBomb[] {
  const bombs: NonCodeBomb[] = [];
  const allFiles = walkFiles(cwd);

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!NON_CODE_EXTS.has(ext)) continue;
    try {
      const stat = statSync(join(cwd, file));
      if (stat.size > TEN_MB) {
        bombs.push({ file, sizeBytes: stat.size });
      }
    } catch { /* skip */ }
  }

  return bombs;
}

// ── Complexity scoring ───────────────────────────────────────────────────────

interface PaddingFile {
  file: string;
  loc: number;
  density: number;
}

function findPaddingFiles(cwd: string): PaddingFile[] {
  const paddings: PaddingFile[] = [];
  const allFiles = walkFiles(cwd);

  for (const file of allFiles) {
    const ext = extname(file).toLowerCase();
    if (!SOURCE_EXTS.has(ext)) continue;

    const content = readFile(join(cwd, file));
    if (!content) continue;

    const lines = content.split('\n');
    const loc = lines.length;
    if (loc <= 1000) continue;

    // Count branch constructs
    let branches = 0;
    for (const line of lines) {
      const matches = line.match(BRANCH_RE);
      if (matches) branches += matches.length;
    }

    const density = branches / loc;
    if (density < 0.02) {
      paddings.push({ file, loc, density });
    }
  }

  return paddings;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

function calculateScore(
  bloatRatio: number,
  bloatedFiles: FileGrowth[],
  bombs: NonCodeBomb[],
  paddings: PaddingFile[],
): { score: number; penalties: string[] } {
  let s = 100;
  const penalties: string[] = [];

  // Bloat ratio penalties
  if (bloatRatio > 20) {
    s -= 40;
    penalties.push(`bloat ratio ${bloatRatio.toFixed(1)}x (>20x): -40`);
  } else if (bloatRatio > 10) {
    s -= 30;
    penalties.push(`bloat ratio ${bloatRatio.toFixed(1)}x (>10x): -30`);
  } else if (bloatRatio > 5) {
    s -= 20;
    penalties.push(`bloat ratio ${bloatRatio.toFixed(1)}x (>5x): -20`);
  }

  // Per-file growth penalties
  const growthPenalty = Math.min(30, bloatedFiles.length * 5);
  if (growthPenalty > 0) {
    s -= growthPenalty;
    penalties.push(`${bloatedFiles.length} file(s) >500% growth: -${growthPenalty}`);
  }

  // Non-code bomb penalties
  const bombPenalty = Math.min(20, bombs.length * 10);
  if (bombPenalty > 0) {
    s -= bombPenalty;
    penalties.push(`${bombs.length} non-code bomb(s) >10MB: -${bombPenalty}`);
  }

  // Padding penalties
  const paddingPenalty = Math.min(20, paddings.length * 5);
  if (paddingPenalty > 0) {
    s -= paddingPenalty;
    penalties.push(`${paddings.length} low-complexity padding file(s): -${paddingPenalty}`);
  }

  return { score: Math.max(0, s), penalties };
}

// ── Format helpers ───────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(0)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

// ── Main check (for full vet run) ────────────────────────────────────────────

export async function checkBloat(cwd: string): Promise<CheckResult> {
  const baseline = findBaseline(cwd);

  if (!baseline.sha) {
    return {
      name: 'bloat',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'empty repo — no bloat analysis possible', fixable: false }],
      summary: 'empty repo',
    };
  }

  const { files, baselineLOC, currentLOC } = analyzeFileGrowth(cwd, baseline.sha);

  // Check if repo has any tracked files
  const trackedFiles = gitExec(['ls-files'], cwd);
  if (!trackedFiles || trackedFiles.trim().length === 0) {
    return {
      name: 'bloat',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'empty repo — no files to analyze', fixable: false }],
      summary: 'empty repo',
    };
  }

  const bloatRatio = baselineLOC > 0 ? currentLOC / baselineLOC : 1;

  const bloatedFiles = files.filter(f => f.growthPct > 500);
  const bombs = findNonCodeBombs(cwd);
  const paddings = findPaddingFiles(cwd);

  const { score: finalScore, penalties } = calculateScore(bloatRatio, bloatedFiles, bombs, paddings);

  const issues: Issue[] = [];

  for (const f of bloatedFiles) {
    issues.push({
      severity: 'warning',
      message: `file growth +${Math.round(f.growthPct)}%: ${f.file} (${f.baselineLines} → ${f.currentLines} lines)`,
      file: f.file,
      fixable: false,
      fixHint: 'review for unnecessary code generation',
    });
  }

  for (const b of bombs) {
    issues.push({
      severity: 'warning',
      message: `non-code bomb: ${b.file} (${formatSize(b.sizeBytes)})`,
      file: b.file,
      fixable: true,
      fixHint: 'add to .gitignore or remove large non-code file',
    });
  }

  for (const p of paddings) {
    issues.push({
      severity: 'warning',
      message: `low-complexity padding: ${p.file} (${p.loc} LOC, density ${p.density.toFixed(3)})`,
      file: p.file,
      fixable: false,
      fixHint: 'review for auto-generated boilerplate',
    });
  }

  if (bloatRatio > 5) {
    issues.push({
      severity: bloatRatio > 20 ? 'error' : 'warning',
      message: `bloat ratio ${bloatRatio.toFixed(1)}x (baseline: ${baselineLOC} LOC → current: ${currentLOC} LOC)`,
      fixable: false,
    });
  }

  const parts: string[] = [];
  parts.push(`${bloatRatio.toFixed(1)}x bloat ratio`);
  if (bloatedFiles.length > 0) parts.push(`${bloatedFiles.length} bloated file(s)`);
  if (bombs.length > 0) parts.push(`${bombs.length} non-code bomb(s)`);
  if (paddings.length > 0) parts.push(`${paddings.length} padding file(s)`);

  return {
    name: 'bloat',
    score: finalScore,
    maxScore: 100,
    issues,
    summary: parts.join(', '),
  };
}

// ── Standalone subcommand ────────────────────────────────────────────────────

export async function runBloatCommand(format: 'ascii' | 'json'): Promise<void> {
  const cwd = process.cwd();
  const baseline = findBaseline(cwd);

  if (!baseline.sha) {
    if (format === 'json') {
      console.log(JSON.stringify({ baseline: null, bloatRatio: 1, score: 100, files: [], message: 'empty repo' }));
    } else {
      console.log(`\n  ${c.bold}vet bloat${c.reset} — agent code bloat detector\n`);
      console.log(`  ${c.dim}empty repo — no bloat analysis possible${c.reset}\n`);
      console.log(`  score: 100/100\n`);
    }
    return;
  }

  const { files, baselineLOC, currentLOC } = analyzeFileGrowth(cwd, baseline.sha);
  const bloatRatio = baselineLOC > 0 ? currentLOC / baselineLOC : 1;

  const bloatedFiles = files.filter(f => f.growthPct > 500);
  const bombs = findNonCodeBombs(cwd);
  const paddings = findPaddingFiles(cwd);

  const { score: finalScore } = calculateScore(bloatRatio, bloatedFiles, bombs, paddings);

  if (format === 'json') {
    const result = {
      baseline: { sha: baseline.sha, message: baseline.message, method: baseline.method },
      bloatRatio: Math.round(bloatRatio * 10) / 10,
      baselineLOC,
      currentLOC,
      score: finalScore,
      bloatedFiles: bloatedFiles.map(f => ({ file: f.file, growthPct: Math.round(f.growthPct), lines: f.currentLines })),
      nonCodeBombs: bombs.map(b => ({ file: b.file, size: b.sizeBytes })),
      paddingFiles: paddings.map(p => ({ file: p.file, loc: p.loc, density: Math.round(p.density * 1000) / 1000 })),
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ASCII output
  console.log(`\n  ${c.bold}vet bloat${c.reset} — agent code bloat detector\n`);
  console.log(`  baseline: ${baseline.sha.substring(0, 7)} (${baseline.message})`);
  console.log(`  bloat ratio: ${bloatRatio.toFixed(1)}x (baseline: ${baselineLOC} LOC → current: ${currentLOC} LOC)\n`);

  const tableRows: { file: string; growth: string; lines: string; complexity: string }[] = [];

  for (const f of bloatedFiles) {
    tableRows.push({
      file: f.file,
      growth: f.isNew ? 'new' : `+${Math.round(f.growthPct)}%`,
      lines: String(f.currentLines),
      complexity: '',
    });
  }

  for (const b of bombs) {
    tableRows.push({
      file: b.file,
      growth: 'new',
      lines: formatSize(b.sizeBytes),
      complexity: 'non-code bomb',
    });
  }

  for (const p of paddings) {
    // Only add if not already in bloatedFiles
    if (!bloatedFiles.some(f => f.file === p.file)) {
      tableRows.push({
        file: p.file,
        growth: '',
        lines: String(p.loc),
        complexity: 'low (padding)',
      });
    } else {
      // Annotate existing row
      const row = tableRows.find(r => r.file === p.file);
      if (row) row.complexity = 'low (padding)';
    }
  }

  if (tableRows.length > 0) {
    console.log(`  ${c.dim}#  file${' '.repeat(30)}growth    lines      complexity${c.reset}`);
    for (let i = 0; i < tableRows.length; i++) {
      const r = tableRows[i];
      const num = String(i + 1).padStart(2);
      const file = r.file.padEnd(35).substring(0, 35);
      const growth = r.growth.padEnd(10);
      const lines = r.lines.padEnd(11);
      console.log(`  ${num} ${file}${growth}${lines}${r.complexity}`);
    }
    console.log('');
  } else {
    console.log(`  ${c.green}no bloat detected${c.reset}\n`);
  }

  console.log(`  score: ${finalScore}/100\n`);
}
