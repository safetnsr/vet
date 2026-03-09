import type { CheckResult, CategoryResult, VetResult } from './types.js';
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Grade thresholds ─────────────────────────────────────────────────────────

export function toGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// ── Category weights ─────────────────────────────────────────────────────────

const WEIGHTS: Record<string, number> = {
  security: 0.20,
  integrity: 0.20,
  debt: 0.15,
  deps: 0.10,
  architecture: 0.10,
  aiready: 0.10,
  history: 0.15,
};

// ── Scoring floor for non-security checks ────────────────────────────────────

const SECURITY_CHECKS = new Set(['scan', 'secrets', 'permissions', 'owasp']);

/** Apply a floor of 25 to non-security checks that have no security-related errors */
export function applyScoreFloor(check: CheckResult): number {
  if (SECURITY_CHECKS.has(check.name)) return check.score;
  // Non-security check: minimum score is 25
  return Math.max(25, check.score);
}

// ── Average scores within a category ────────────────────────────────────────

function averageScore(checks: CheckResult[]): number {
  if (checks.length === 0) return 100;
  const total = checks.reduce((sum, c) => sum + applyScoreFloor(c), 0);
  return Math.round(total / checks.length);
}

// ── Completeness multiplier ─────────────────────────────────────────────────

/**
 * Extract completeness score and apply it as a multiplier to the overall score.
 * A repo with completeness=0 (no JS/TS source) gets heavily penalized.
 * Steeper curve to better separate quality tiers:
 * completeness 0-25 → multiplier 0.2-0.45
 * completeness 25-50 → multiplier 0.45-0.65
 * completeness 50-75 → multiplier 0.65-0.85
 * completeness 75-100 → multiplier 0.85-1.0
 */
function completenessMultiplier(categories: CategoryResult[]): number {
  const integrity = categories.find(c => c.name === 'integrity');
  if (!integrity) return 1.0;
  const comp = integrity.checks.find(c => c.name === 'completeness');
  if (!comp) return 1.0;
  const s = comp.score;
  if (s >= 75) return 0.85 + (s - 75) * (0.15 / 25);
  if (s >= 50) return 0.65 + (s - 50) * (0.20 / 25);
  if (s >= 25) return 0.45 + (s - 25) * (0.20 / 25);
  return 0.20 + s * (0.25 / 25);
}

// ── Group checks into categories ─────────────────────────────────────────────

export function buildCategories(checkMap: {
  security: CheckResult[];
  integrity: CheckResult[];
  debt: CheckResult[];
  deps: CheckResult[];
  architecture: CheckResult[];
  aiready: CheckResult[];
  history: CheckResult[];
}): CategoryResult[] {
  const categories: CategoryResult[] = [];

  for (const name of ['security', 'integrity', 'debt', 'deps', 'architecture', 'aiready', 'history'] as const) {
    const checks = checkMap[name];
    if (!checks || checks.length === 0) continue;
    const score = averageScore(checks);
    const issues = checks.flatMap(c => c.issues);
    categories.push({
      name,
      score,
      weight: WEIGHTS[name] || 0.10,
      checks,
      issues,
    });
  }

  return categories;
}

// ── Build VetResult from categories ─────────────────────────────────────────

export function buildVetResult(project: string, categories: CategoryResult[]): VetResult {
  // Weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  for (const cat of categories) {
    weightedSum += cat.score * cat.weight;
    totalWeight += cat.weight;
  }
  const rawScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const compMult = completenessMultiplier(categories);
  const overallScore = Math.round(rawScore * compMult);
  const grade = toGrade(overallScore);

  const allIssues = categories.flatMap(c => c.issues);

  // Read version from package.json
  let version = '1.0.0';
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
    version = pkg.version || version;
  } catch { /* use default */ }

  return {
    project: basename(project),
    version,
    score: overallScore,
    grade,
    categories,
    totalIssues: allIssues.length,
    fixableIssues: allIssues.filter(i => i.fixable).length,
    timestamp: new Date().toISOString(),
  };
}
