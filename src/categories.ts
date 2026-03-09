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

const WEIGHTS = {
  security: 0.25,
  integrity: 0.35,
  debt: 0.30,
  deps: 0.10,
} as const;

// ── Scoring floor for non-security checks ────────────────────────────────────

const SECURITY_CHECKS = new Set(['scan', 'secrets', 'permissions', 'owasp']);

/** Apply a floor of 20 to non-security checks that have no security-related errors */
export function applyScoreFloor(check: CheckResult): number {
  if (SECURITY_CHECKS.has(check.name)) return check.score;
  // Non-security check: minimum score is 20
  return Math.max(20, check.score);
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
 * completeness 0-30 → multiplier 0.3-0.6
 * completeness 30-70 → multiplier 0.6-0.85
 * completeness 70-100 → multiplier 0.85-1.0
 */
function completenessMultiplier(categories: CategoryResult[]): number {
  const integrity = categories.find(c => c.name === 'integrity');
  if (!integrity) return 1.0;
  const comp = integrity.checks.find(c => c.name === 'completeness');
  if (!comp) return 1.0;
  const s = comp.score;
  if (s >= 70) return 0.85 + (s - 70) * (0.15 / 30);
  if (s >= 30) return 0.6 + (s - 30) * (0.25 / 40);
  return 0.3 + s * (0.3 / 30);
}

// ── Group checks into categories ─────────────────────────────────────────────

export function buildCategories(checkMap: {
  security: CheckResult[];
  integrity: CheckResult[];
  debt: CheckResult[];
  deps: CheckResult[];
}): CategoryResult[] {
  const categories: CategoryResult[] = [];

  for (const name of ['security', 'integrity', 'debt', 'deps'] as const) {
    const checks = checkMap[name];
    const score = averageScore(checks);
    const issues = checks.flatMap(c => c.issues);
    categories.push({
      name,
      score,
      weight: WEIGHTS[name],
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
