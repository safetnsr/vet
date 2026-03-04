import { execFileSync } from 'node:child_process';
import type { CheckResult, Issue } from '../types.js';

// ── Commit classification ────────────────────────────────────────────────────

type CommitCategory = 'architecture' | 'debugging' | 'integration' | 'feature' | 'boilerplate' | 'cosmetic';

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  dirsChanged: number;
  files: string[];
}

interface ClassifiedCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
  category: CommitCategory;
  score: number;
  reasoning: string;
  stats: DiffStats;
}

const CATEGORY_SCORES: Record<CommitCategory, number> = {
  architecture: 90,
  debugging: 85,
  integration: 80,
  feature: 60,
  boilerplate: 20,
  cosmetic: 10,
};

const BOILERPLATE_RE = [/\bcrud\b/i, /\bscaffold/i, /\bgenerat(e|ed|ing)\b/i, /\binit(ial)?\b/i, /\bboilerplate\b/i, /\btemplate\b/i, /\bsetup\b/i];
const COSMETIC_RE = [/\brenam(e|ed|ing)\b/i, /\bformat(ting)?\b/i, /\blint(ing)?\b/i, /\bprettier\b/i, /\bstyle\b/i, /\bwhitespace\b/i, /\btypo\b/i];
const DEBUG_RE = [/\bfix(e[ds])?\b/i, /\bbug\b/i, /\bdebug/i, /\bpatch\b/i, /\bhotfix\b/i, /\bresolv(e|ed|ing)\b/i, /\berror\b/i, /\bissue\b/i];
const INTEGRATION_RE = [/\bintegrat(e|ion|ing)\b/i, /\bapi\b/i, /\bwebhook\b/i, /\bmigrat(e|ion|ing)\b/i, /\bdatabase\b/i, /\bqueue\b/i, /\bconnect/i, /\bpipeline\b/i, /\bauth(entication|orization)?\b/i];

function getUniqueDirs(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    dirs.add(parts.length > 1 ? parts.slice(0, -1).join('/') : '.');
  }
  return [...dirs];
}

function hasMultiSystemFiles(files: string[]): boolean {
  const layers = new Set<string>();
  for (const f of files) {
    const lower = f.toLowerCase();
    if (/route|controller|handler/.test(lower)) layers.add('api');
    if (/model|schema|migration|db/.test(lower)) layers.add('db');
    if (/test|spec/.test(lower)) layers.add('test');
    if (/config|\.env|yaml|yml/.test(lower)) layers.add('config');
    if (/middleware|auth/.test(lower)) layers.add('middleware');
    if (/service|worker/.test(lower)) layers.add('service');
  }
  return layers.size >= 2;
}

function isCosmetic(stats: DiffStats, message: string): boolean {
  const total = stats.insertions + stats.deletions;
  if (total < 10 && COSMETIC_RE.some(p => p.test(message))) return true;
  if (stats.insertions > 0 && stats.deletions > 0 &&
    Math.abs(stats.insertions - stats.deletions) <= 2 &&
    total < 20 && COSMETIC_RE.some(p => p.test(message))) return true;
  return false;
}

function classifyCommit(hash: string, date: string, message: string, author: string, stats: DiffStats): ClassifiedCommit {
  const { filesChanged, insertions, deletions, dirsChanged } = stats;
  const total = insertions + deletions;
  let category: CommitCategory;
  let reasoning: string;

  if (isCosmetic(stats, message)) {
    category = 'cosmetic';
    reasoning = `Small change (${total} lines) matching cosmetic patterns`;
  } else if (BOILERPLATE_RE.some(p => p.test(message)) && (insertions > deletions * 3 || deletions === 0)) {
    category = 'boilerplate';
    reasoning = `Scaffolding pattern in commit message (${insertions} insertions, ${deletions} deletions)`;
  } else if (dirsChanged >= 3 && filesChanged >= 4) {
    category = 'architecture';
    reasoning = `Cross-directory changes (${dirsChanged} dirs, ${filesChanged} files) — structural refactoring`;
  } else if (filesChanged <= 2 && total <= 30 && DEBUG_RE.some(p => p.test(message))) {
    category = 'debugging';
    reasoning = `Targeted fix (${total} lines in ${filesChanged} file${filesChanged > 1 ? 's' : ''}) — context-heavy debugging`;
  } else if (INTEGRATION_RE.some(p => p.test(message)) || (dirsChanged >= 2 && hasMultiSystemFiles(stats.files))) {
    category = 'integration';
    reasoning = 'Multi-system wiring — connecting different parts of the stack';
  } else if (insertions > 100 && deletions < 10 && filesChanged >= 3 && deletions < insertions * 0.1) {
    category = 'boilerplate';
    reasoning = `Uniform additions (${insertions} insertions, ${deletions} deletions)`;
  } else if (total > 0) {
    if (dirsChanged >= 2 && filesChanged >= 3 && total > 50) {
      category = 'architecture';
      reasoning = `Multi-directory changes (${dirsChanged} dirs, ${filesChanged} files, ${total} lines)`;
    } else if (DEBUG_RE.some(p => p.test(message)) && filesChanged <= 3) {
      category = 'debugging';
      reasoning = `Bug fix across ${filesChanged} file${filesChanged > 1 ? 's' : ''}`;
    } else {
      category = 'feature';
      reasoning = `Feature work (${filesChanged} file${filesChanged > 1 ? 's' : ''}, ${total} lines)`;
    }
  } else {
    category = 'cosmetic';
    reasoning = 'Empty or metadata-only commit';
  }

  return { hash: hash.slice(0, 8), date, message: message.slice(0, 80), author, category, score: CATEGORY_SCORES[category], reasoning, stats };
}

// ── Git log parsing (no simple-git, uses execSync) ───────────────────────────

function gitRaw(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function getCommitStats(hash: string, cwd: string): DiffStats {
  let raw = gitRaw(['diff', '--numstat', `${hash}^`, hash, '--'], cwd);
  if (!raw) {
    raw = gitRaw(['diff-tree', '--numstat', '--root', hash, '--'], cwd);
  }

  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of raw.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      insertions += parts[0] === '-' ? 0 : (parseInt(parts[0] ?? '0', 10) || 0);
      deletions += parts[1] === '-' ? 0 : (parseInt(parts[1] ?? '0', 10) || 0);
      if (parts[2]) files.push(parts[2]);
    }
  }

  return { filesChanged: files.length, insertions, deletions, dirsChanged: getUniqueDirs(files).length, files };
}

export interface EdgeAnalysis {
  score: number;
  totalCommits: number;
  distribution: Record<CommitCategory, number>;
  topCommits: ClassifiedCommit[];
  recommendation: string;
}

function getRecommendation(dist: Record<CommitCategory, number>, total: number): string {
  if (total === 0) return 'no commits to analyze';
  const boilerPct = ((dist.boilerplate + dist.cosmetic) / total) * 100;
  const archPct = ((dist.architecture + dist.integration) / total) * 100;
  if (boilerPct > 40) return 'Focus more on cross-system architecture and targeted debugging. Delegate scaffolding to AI.';
  if (archPct > 50) return 'Strong position. Your work is deeply contextual and hard to automate.';
  if (dist.debugging > dist.architecture) return 'Good debugging instinct. Level up by taking on more cross-system architecture.';
  return 'Balanced mix. Push toward more integration and architecture work to increase your irreplaceability.';
}

export function analyzeEdge(cwd: string, maxCommits = 50): EdgeAnalysis {
  const raw = gitRaw(['log', '--format=%H|%aI|%an|%s', '--no-merges', `-n`, String(maxCommits)], cwd);
  const lines = raw.split('\n').filter(Boolean);

  const commits: ClassifiedCommit[] = [];
  for (const line of lines) {
    const pipeIdx = line.indexOf('|');
    const rest = line.slice(pipeIdx + 1);
    const hash = line.slice(0, pipeIdx);
    const [date, author, ...msgParts] = rest.split('|');
    const message = msgParts.join('|');
    if (!hash) continue;
    const stats = getCommitStats(hash, cwd);
    commits.push(classifyCommit(hash, date ?? '', message ?? '', author ?? '', stats));
  }

  const dist: Record<CommitCategory, number> = { architecture: 0, debugging: 0, integration: 0, feature: 0, boilerplate: 0, cosmetic: 0 };
  for (const c of commits) dist[c.category]++;

  const overallScore = commits.length > 0
    ? Math.round(commits.reduce((s, c) => s + c.score, 0) / commits.length)
    : 0;

  const topCommits = [...commits].sort((a, b) => b.score - a.score).slice(0, 3);

  return { score: overallScore, totalCommits: commits.length, distribution: dist, topCommits, recommendation: getRecommendation(dist, commits.length) };
}

// ── CheckResult adapter ──────────────────────────────────────────────────────

export function checkEdge(cwd: string): CheckResult {
  const analysis = analyzeEdge(cwd);
  const issues: Issue[] = [];

  if (analysis.totalCommits === 0) {
    return { name: 'edge', score: 5, maxScore: 10, issues: [{ severity: 'info', message: 'no commits to analyze', fixable: false }], summary: 'no git history' };
  }

  const { distribution: dist, totalCommits: total } = analysis;
  const boilerPct = Math.round(((dist.boilerplate + dist.cosmetic) / total) * 100);
  const archPct = Math.round(((dist.architecture + dist.integration) / total) * 100);

  if (boilerPct > 50) {
    issues.push({ severity: 'warning', message: `${boilerPct}% of commits are boilerplate/cosmetic — high automation risk`, fixable: false });
  }
  if (archPct > 40) {
    issues.push({ severity: 'info', message: `${archPct}% architecture/integration work — strong human edge`, fixable: false });
  }
  if (analysis.topCommits.length > 0) {
    const top = analysis.topCommits[0]!;
    issues.push({ severity: 'info', message: `top commit: ${top.hash} (${top.category}, ${top.score}/100) — ${top.message.slice(0, 50)}`, fixable: false });
  }

  // Map 0-100 score to 0-10
  const vetScore = Math.round(analysis.score / 10);

  return {
    name: 'edge',
    score: vetScore,
    maxScore: 10,
    issues,
    summary: `${total} commits — human edge score ${analysis.score}/100 — ${analysis.recommendation.slice(0, 60)}`,
  };
}

// ── Standalone subcommand output ─────────────────────────────────────────────

export function runEdgeCommand(cwd: string, explain = false): void {
  const analysis = analyzeEdge(cwd, explain ? 100 : 50);

  if (analysis.totalCommits === 0) {
    console.log('\n  no commits to analyze\n');
    return;
  }

  const { distribution: dist, totalCommits: total, score, topCommits, recommendation } = analysis;

  const scoreColor = score >= 70 ? '\x1b[32m' : score >= 40 ? '\x1b[33m' : '\x1b[31m';
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';

  console.log('');
  console.log(`  ${BOLD}Human Edge Report${RESET}  ${scoreColor}${score}/100${RESET}`);
  console.log(`  ${DIM}${total} commits analyzed${RESET}`);
  console.log('');

  const cats: CommitCategory[] = ['architecture', 'debugging', 'integration', 'feature', 'boilerplate', 'cosmetic'];
  const catEmoji: Record<CommitCategory, string> = { architecture: '🏗️', debugging: '🔍', integration: '🔗', feature: '⚡', boilerplate: '📋', cosmetic: '🎨' };
  for (const cat of cats) {
    if (dist[cat] === 0) continue;
    const pct = Math.round((dist[cat] / total) * 100);
    const bar = '█'.repeat(Math.max(1, Math.round(pct / 5)));
    const catScore = CATEGORY_SCORES[cat];
    const color = catScore >= 70 ? '\x1b[32m' : catScore >= 40 ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${catEmoji[cat]} ${cat.padEnd(14)} ${color}${String(dist[cat]).padStart(3)}${RESET} ${DIM}(${String(pct).padStart(2)}%)${RESET} ${color}${bar}${RESET}`);
  }

  console.log('');
  console.log(`  ${BOLD}Top commits${RESET}`);
  for (const c of topCommits) {
    console.log(`  ${scoreColor}${c.score}${RESET}  ${c.hash}  ${c.message.slice(0, 55)}`);
  }

  console.log('');
  console.log(`  → ${recommendation}`);
  console.log('');
}
