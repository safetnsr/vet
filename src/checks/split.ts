import { gitExec, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface Hunk {
  file: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  content: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  isBinary: boolean;
}

interface Cluster {
  name: string;
  prefix: string;
  files: string[];
  hunks: Hunk[];
  commitMessage: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CONFIG_FILES = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.prettierrc.json',
  '.env', '.env.example', '.env.local', '.gitignore', '.npmignore',
  'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vite.config.ts',
  'webpack.config.js', 'rollup.config.js', 'esbuild.config.js',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.dockerignore', 'Makefile', '.editorconfig',
]);

const TEST_PATTERNS = [/^test\//, /^tests\//, /^__tests__\//, /\.test\./, /\.spec\./];
const FIX_INDICATORS = /\bfix(es|ed)?\b|\bbug\b|\berror\b|\bcrash\b|\bpatch\b/i;

// ── Diff parsing ─────────────────────────────────────────────────────────────

function parseDiff(diffOutput: string): Hunk[] {
  if (!diffOutput.trim()) return [];

  const hunks: Hunk[] = [];
  const fileDiffs = diffOutput.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    const lines = fileDiff.split('\n');

    // Parse file paths
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const file = headerMatch[2];

    // Detect binary
    if (fileDiff.includes('Binary files')) {
      hunks.push({
        file, oldStart: 0, oldCount: 0, newStart: 0, newCount: 0,
        content: '', isNew: false, isDeleted: false, isRenamed: false, isBinary: true,
      });
      continue;
    }

    const isNew = fileDiff.includes('new file mode');
    const isDeleted = fileDiff.includes('deleted file mode');
    const isRenamed = fileDiff.includes('rename from') || fileDiff.includes('similarity index');

    // Parse individual hunks within the file
    const hunkHeaderRE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
    let currentHunkLines: string[] = [];
    let currentMatch: RegExpMatchArray | null = null;

    for (const line of lines) {
      const match = line.match(hunkHeaderRE);
      if (match) {
        // Save previous hunk
        if (currentMatch) {
          hunks.push({
            file,
            oldStart: parseInt(currentMatch[1], 10),
            oldCount: parseInt(currentMatch[2] || '1', 10),
            newStart: parseInt(currentMatch[3], 10),
            newCount: parseInt(currentMatch[4] || '1', 10),
            content: currentHunkLines.join('\n'),
            isNew, isDeleted, isRenamed, isBinary: false,
          });
        }
        currentMatch = match;
        currentHunkLines = [];
      } else if (currentMatch) {
        currentHunkLines.push(line);
      }
    }

    // Save last hunk
    if (currentMatch) {
      hunks.push({
        file,
        oldStart: parseInt(currentMatch[1], 10),
        oldCount: parseInt(currentMatch[2] || '1', 10),
        newStart: parseInt(currentMatch[3], 10),
        newCount: parseInt(currentMatch[4] || '1', 10),
        content: currentHunkLines.join('\n'),
        isNew, isDeleted, isRenamed, isBinary: false,
      });
    } else if (isNew || isDeleted) {
      // File with no hunks (e.g., empty new file)
      hunks.push({
        file, oldStart: 0, oldCount: 0, newStart: 0, newCount: 0,
        content: '', isNew, isDeleted, isRenamed, isBinary: false,
      });
    }
  }

  return hunks;
}

// ── Clustering ───────────────────────────────────────────────────────────────

function isTestFile(file: string): boolean {
  return TEST_PATTERNS.some(p => p.test(file));
}

function isConfigFile(file: string): boolean {
  const basename = file.split('/').pop() || file;
  return CONFIG_FILES.has(basename) || basename.startsWith('.');
}

function getClusterKey(file: string): string {
  if (isTestFile(file)) return 'test';
  if (isConfigFile(file)) return 'config';

  // Group by first directory
  const parts = file.split('/');
  if (parts.length > 1) return `src:${parts[0]}`;
  return 'src:root';
}

function generateCommitMessage(cluster: Cluster): string {
  const fileList = cluster.files.length <= 3
    ? cluster.files.map(f => f.split('/').pop()).join(', ')
    : `${cluster.files.length} files`;

  // Test cluster
  if (cluster.prefix === 'test') {
    return `test: update ${fileList}`;
  }

  // Config cluster
  if (cluster.prefix === 'config') {
    return `chore: update ${fileList}`;
  }

  // Check if all files are new
  const allNew = cluster.hunks.every(h => h.isNew);
  if (allNew) {
    return `feat: add ${fileList}`;
  }

  // Check if all files are deleted
  const allDeleted = cluster.hunks.every(h => h.isDeleted);
  if (allDeleted) {
    return `refactor: remove ${fileList}`;
  }

  // Check hunk content for fix indicators
  const allContent = cluster.hunks.map(h => h.content).join('\n');
  if (FIX_INDICATORS.test(allContent)) {
    return `fix: update ${fileList}`;
  }

  return `refactor: update ${fileList}`;
}

function clusterHunks(hunks: Hunk[]): Cluster[] {
  // Filter out binary files
  const nonBinary = hunks.filter(h => !h.isBinary);
  if (nonBinary.length === 0) return [];

  const groups = new Map<string, Hunk[]>();

  for (const hunk of nonBinary) {
    const key = getClusterKey(hunk.file);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(hunk);
  }

  const clusters: Cluster[] = [];

  for (const [key, groupHunks] of groups) {
    const files = [...new Set(groupHunks.map(h => h.file))];
    const cluster: Cluster = {
      name: key,
      prefix: key.startsWith('src:') ? 'src' : key,
      files,
      hunks: groupHunks,
      commitMessage: '',
    };
    cluster.commitMessage = generateCommitMessage(cluster);
    clusters.push(cluster);
  }

  // Sort: config first, then src, then test
  clusters.sort((a, b) => {
    const order = (c: Cluster) => c.prefix === 'config' ? 0 : c.prefix === 'src' ? 1 : 2;
    return order(a) - order(b);
  });

  return clusters;
}

// ── Score calculation ────────────────────────────────────────────────────────

function analyzeCommit(cwd: string, sha: string): { fileCount: number; clusterCount: number; totalHunks: number } {
  const diff = gitExec(['diff', `${sha}~1`, sha], cwd);
  if (!diff) return { fileCount: 0, clusterCount: 0, totalHunks: 0 };

  const hunks = parseDiff(diff);
  const nonBinary = hunks.filter(h => !h.isBinary);
  const clusters = clusterHunks(nonBinary);
  const files = new Set(nonBinary.map(h => h.file));

  return { fileCount: files.size, clusterCount: clusters.length, totalHunks: nonBinary.length };
}

// ── Main check (for scorecard) ───────────────────────────────────────────────

export function checkSplit(cwd: string): CheckResult {
  const issues: Issue[] = [];

  // Get recent commits (last 10)
  const log = gitExec(['log', '--oneline', '-10', '--format=%H'], cwd);
  if (!log) {
    return {
      name: 'split',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no commits to analyze', fixable: false }],
      summary: 'no commits',
    };
  }

  const shas = log.split('\n').filter(Boolean);
  let totalPenalty = 0;
  let analyzedCount = 0;

  for (const sha of shas) {
    // Check if commit has a parent
    const parent = gitExec(['rev-parse', `${sha}~1`], cwd);
    if (!parent) continue;

    const analysis = analyzeCommit(cwd, sha);
    analyzedCount++;

    if (analysis.fileCount === 0) continue;

    // Penalty for large multi-concern commits
    if (analysis.clusterCount > 1 && analysis.fileCount > 5) {
      const severity = analysis.clusterCount > 3 ? 'warning' as const : 'info' as const;
      const shortSha = sha.substring(0, 7);
      const penalty = Math.min(20, (analysis.clusterCount - 1) * 5);
      totalPenalty += penalty;

      issues.push({
        severity,
        message: `commit ${shortSha} touches ${analysis.fileCount} files across ${analysis.clusterCount} concerns`,
        fixable: true,
        fixHint: `run: vet split --since ${shortSha}~1`,
      });
    }

    if (analysis.fileCount > 20) {
      totalPenalty += 15;
      issues.push({
        severity: 'warning',
        message: `commit ${sha.substring(0, 7)} modifies ${analysis.fileCount} files — likely needs splitting`,
        fixable: true,
        fixHint: 'run: vet split',
      });
    }
  }

  const score = Math.max(0, 100 - totalPenalty);
  const summary = issues.length === 0
    ? 'all recent commits are atomic'
    : `${issues.length} commit(s) could be split into smaller atomic commits`;

  return { name: 'split', score, maxScore: 100, issues, summary };
}

// ── Subcommand ───────────────────────────────────────────────────────────────

export async function runSplitCommand(
  format: string,
  cwd: string,
  since?: string,
  apply?: boolean,
  force?: boolean,
): Promise<void> {
  const ref = since || 'HEAD~1';

  // Get the diff
  const diff = gitExec(['diff', ref, 'HEAD'], cwd);
  if (!diff.trim()) {
    if (format === 'json') {
      console.log(JSON.stringify({ clusters: [], message: 'no changes to split' }));
    } else {
      console.log(`\n  ${c.bold}vet split${c.reset} — commit surgery\n`);
      console.log(`  ${c.dim}no changes between ${ref} and HEAD${c.reset}\n`);
    }
    return;
  }

  const hunks = parseDiff(diff);
  const clusters = clusterHunks(hunks);

  if (clusters.length <= 1) {
    if (format === 'json') {
      console.log(JSON.stringify({
        clusters: clusters.map(cl => ({
          name: cl.name, prefix: cl.prefix, files: cl.files,
          hunkCount: cl.hunks.length, commitMessage: cl.commitMessage,
        })),
        message: 'commit is already atomic',
      }));
    } else {
      console.log(`\n  ${c.bold}vet split${c.reset} — commit surgery\n`);
      console.log(`  ${c.green}commit is already atomic — no split needed${c.reset}\n`);
    }
    return;
  }

  // JSON output
  if (format === 'json') {
    const output = {
      ref,
      clusterCount: clusters.length,
      clusters: clusters.map(cl => ({
        name: cl.name,
        prefix: cl.prefix,
        files: cl.files,
        hunkCount: cl.hunks.length,
        commitMessage: cl.commitMessage,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // ASCII table output
  console.log(`\n  ${c.bold}vet split${c.reset} — commit surgery\n`);
  console.log(`  analyzing changes since ${c.cyan}${ref}${c.reset}\n`);
  console.log(`  ${c.dim}#  commit message${' '.repeat(35)}files  hunks${c.reset}`);

  for (let i = 0; i < clusters.length; i++) {
    const cl = clusters[i];
    const num = String(i + 1).padStart(2);
    const msg = cl.commitMessage.padEnd(50).substring(0, 50);
    const files = String(cl.files.length).padStart(5);
    const hunkCount = String(cl.hunks.length).padStart(6);
    console.log(`  ${num} ${msg}${files}${hunkCount}`);

    for (const file of cl.files) {
      console.log(`     ${c.dim}${file}${c.reset}`);
    }
  }

  console.log(`\n  ${c.bold}${clusters.length} atomic commits${c.reset} proposed\n`);

  if (!apply) {
    console.log(`  ${c.dim}dry run — use --apply to execute${c.reset}\n`);
    return;
  }

  // Apply mode: safety checks
  const currentBranch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if ((currentBranch === 'main' || currentBranch === 'master') && !force) {
    console.log(`  ${c.red}refusing to rewrite history on ${currentBranch}${c.reset}`);
    console.log(`  ${c.dim}use --force to override${c.reset}\n`);
    return;
  }

  // Create backup branch
  const backupBranch = `vet-split-backup-${Date.now()}`;
  gitExec(['branch', backupBranch], cwd);
  console.log(`  ${c.dim}backup branch: ${backupBranch}${c.reset}`);

  // Soft reset to the ref point
  gitExec(['reset', '--soft', ref], cwd);
  gitExec(['reset', 'HEAD'], cwd);

  // Apply each cluster as a separate commit
  for (const cl of clusters) {
    for (const file of cl.files) {
      gitExec(['add', file], cwd);
    }
    gitExec(['commit', '-m', cl.commitMessage], cwd);
    console.log(`  ${c.green}committed:${c.reset} ${cl.commitMessage}`);
  }

  console.log(`\n  ${c.green}split complete${c.reset} — ${clusters.length} atomic commits created`);
  console.log(`  ${c.dim}backup: ${backupBranch}${c.reset}\n`);
}
