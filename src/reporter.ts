import type { VetResult, CheckResult, Issue } from './types.js';
import { c } from './util.js';

const BAR_WIDTH = 10;

function bar(score: number, max: number): string {
  const filled = Math.round((score / max) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const color = score >= 8 ? c.green : score >= 5 ? c.yellow : c.red;
  return `${color}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
}

function severityIcon(s: Issue['severity']): string {
  switch (s) {
    case 'error': return `${c.red}✗${c.reset}`;
    case 'warning': return `${c.yellow}!${c.reset}`;
    case 'info': return `${c.blue}·${c.reset}`;
  }
}

export function reportPretty(result: VetResult): string {
  const lines: string[] = [];
  const scoreColor = result.score >= 8 ? c.green : result.score >= 5 ? c.yellow : c.red;

  lines.push('');
  lines.push(`  ${c.bold}${result.project}${c.reset}  ${scoreColor}${result.score.toFixed(1)}/10${c.reset}`);
  lines.push('');

  for (const check of result.checks) {
    const pad = ' '.repeat(Math.max(0, 10 - check.name.length));
    lines.push(`  ${check.name}${pad}${bar(check.score, check.maxScore)}  ${check.score.toFixed(0).padStart(2)}    ${c.dim}${check.summary}${c.reset}`);
  }

  // Issues
  const allIssues = result.checks.flatMap(ch => ch.issues);
  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');

  if (errors.length > 0 || warnings.length > 0) {
    lines.push('');
    const issueList = [...errors, ...warnings].slice(0, 10); // top 10
    for (const issue of issueList) {
      const loc = issue.file ? `${c.dim}${issue.file}${issue.line ? ':' + issue.line : ''}${c.reset} ` : '';
      lines.push(`  ${severityIcon(issue.severity)} ${loc}${issue.message}`);
    }
    const remaining = errors.length + warnings.length - issueList.length;
    if (remaining > 0) {
      lines.push(`  ${c.dim}...and ${remaining} more${c.reset}`);
    }
  }

  if (result.fixableIssues > 0) {
    lines.push('');
    lines.push(`  ${c.cyan}run with --fix to auto-repair ${result.fixableIssues} issue${result.fixableIssues > 1 ? 's' : ''}${c.reset}`);
  }

  lines.push('');
  return lines.join('\n');
}

export function reportJSON(result: VetResult): string {
  return JSON.stringify(result, null, 2);
}
