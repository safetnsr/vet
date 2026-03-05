import type { VetResult, CategoryResult, Issue } from './types.js';
import { c } from './util.js';

const BAR_WIDTH = 11;

function bar(score: number): string {
  const filled = Math.round((score / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const color = score >= 90 ? c.green : score >= 60 ? c.yellow : c.red;
  return `${color}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return c.green;
    case 'B': return c.green;
    case 'C': return c.yellow;
    case 'D': return c.yellow;
    default: return c.red;
  }
}

function categoryLabel(name: string): string {
  return name.padEnd(10);
}

export function reportPretty(result: VetResult): string {
  const lines: string[] = [];

  // Read version from result
  const version = result.version || '1.0.0';

  lines.push('');
  lines.push(`  ${c.bold}vet v${version}${c.reset} ${c.dim}— AI code health${c.reset}`);
  lines.push('');

  // Category rows
  for (const cat of result.categories) {
    const scoreStr = `${cat.score}/100`;
    const pad = ' '.repeat(Math.max(0, 6 - scoreStr.length));
    lines.push(`  ${categoryLabel(cat.name)}${scoreStr}${pad}  ${bar(cat.score)}`);
  }

  // Overall grade
  const gc = gradeColor(result.grade);
  lines.push('');
  lines.push(`  ${c.bold}overall: ${gc}${result.grade}${c.reset}${c.bold} (${result.score}/100)${c.reset}`);
  lines.push('');

  // Top fixes: prioritize errors over warnings, max 5
  const allIssues = result.categories.flatMap(cat => cat.issues);
  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');
  const topFixes = [...errors, ...warnings].slice(0, 5);

  if (topFixes.length > 0) {
    lines.push(`  ${c.dim}top fixes:${c.reset}`);
    for (let i = 0; i < topFixes.length; i++) {
      const issue = topFixes[i];
      const loc = issue.file
        ? `${issue.file}${issue.line ? ':' + issue.line : ''} — `
        : '';
      lines.push(`  ${i + 1}. ${c.dim}${loc}${c.reset}${issue.message}`);
    }
    const remaining = errors.length + warnings.length - topFixes.length;
    if (remaining > 0) {
      lines.push(`  ${c.dim}...and ${remaining} more${c.reset}`);
    }
    lines.push('');
  }

  if (result.fixableIssues > 0) {
    lines.push(`  ${c.cyan}run with --fix to auto-repair ${result.fixableIssues} issue${result.fixableIssues > 1 ? 's' : ''}${c.reset}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function reportJSON(result: VetResult): string {
  return JSON.stringify(result, null, 2);
}

export function reportBadge(result: VetResult): string {
  const grade = result.grade;
  const score = result.score;
  const label = encodeURIComponent(`vet-${grade} (${score}/100)`);

  let color = 'red';
  if (score >= 90) color = 'brightgreen';
  else if (score >= 75) color = 'green';
  else if (score >= 60) color = 'yellow';
  else if (score >= 40) color = 'orange';

  return `![vet](https://img.shields.io/badge/${label}-${color})`;
}
