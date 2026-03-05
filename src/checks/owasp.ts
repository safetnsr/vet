import type { CheckResult, Issue } from '../types.js';
import {
  type OwaspFinding,
  collectAgentConfigFiles,
  collectMcpConfigFiles,
  checkASI01,
  checkASI02,
  checkASI03,
  checkASI04,
  checkASI05,
  checkASI06,
  checkASI07,
  checkASI08,
  checkASI09,
  checkASI10,
} from './owasp-checks.js';

// ── Main export ───────────────────────────────────────────────────────────────

export function checkOwasp(cwd: string): CheckResult {
  const allConfigFiles = collectAgentConfigFiles(cwd);
  const mcpFiles = collectMcpConfigFiles(cwd);

  // No agent config files at all → not applicable
  if (allConfigFiles.length === 0) {
    return {
      name: 'owasp',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no agent config files found — not applicable',
    };
  }

  const allFindings: OwaspFinding[] = [];
  let totalDeduction = 0;

  // Run all ASI checks
  const checks = [
    checkASI01(cwd, allConfigFiles),
    checkASI02(cwd, mcpFiles),
    checkASI03(cwd, allConfigFiles),
    checkASI04(cwd, mcpFiles, allConfigFiles),
    checkASI05(cwd, allConfigFiles),
    checkASI06(cwd),
    checkASI07(cwd, allConfigFiles),
    checkASI08(cwd, allConfigFiles),
    checkASI09(cwd, allConfigFiles),
    checkASI10(cwd, allConfigFiles),
  ];

  for (const { findings, deduction } of checks) {
    allFindings.push(...findings);
    totalDeduction += deduction;
  }

  const finalScore = Math.max(0, 100 - totalDeduction);

  const issues: Issue[] = allFindings.map(f => ({
    severity: f.severity,
    message: f.message,
    file: f.file,
    line: f.line,
    fixable: false,
    fixHint: f.fixHint,
  }));

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;
  const configCount = allConfigFiles.length;

  const summary = issues.length === 0
    ? `${configCount} agent config file${configCount !== 1 ? 's' : ''} — OWASP Agentic Top 10 clean`
    : `${configCount} config file${configCount !== 1 ? 's' : ''} — ${errorCount > 0 ? `${errorCount} error${errorCount !== 1 ? 's' : ''}, ` : ''}${warnCount} OWASP finding${warnCount !== 1 ? 's' : ''} (ASI01-ASI10)`;

  return {
    name: 'owasp',
    score: finalScore,
    maxScore: 100,
    issues,
    summary,
  };
}
