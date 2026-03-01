import type { CheckResult, VetResult } from './types.js';
import { basename } from 'node:path';

export function score(project: string, checks: CheckResult[]): VetResult {
  const totalScore = checks.reduce((sum, ch) => sum + ch.score, 0);
  const maxTotal = checks.reduce((sum, ch) => sum + ch.maxScore, 0);
  const normalized = maxTotal > 0 ? (totalScore / maxTotal) * 10 : 10;

  const allIssues = checks.flatMap(ch => ch.issues);

  return {
    project: basename(project),
    score: Math.round(normalized * 10) / 10,
    checks,
    totalIssues: allIssues.length,
    fixableIssues: allIssues.filter(i => i.fixable).length,
    timestamp: new Date().toISOString(),
  };
}
