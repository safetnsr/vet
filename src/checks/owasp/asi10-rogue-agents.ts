import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI10 — Rogue Agents ─────────────────────────────────────────────────────

export function checkASI10(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  if (configFiles.length === 0) return { findings, deduction: 0 };

  const monitoringKeywords = [
    'log', 'audit', 'monitor', 'alert', 'trace', 'observ', 'kill switch',
    'stop', 'timeout', 'session limit', 'max token', 'budget', 'governance',
  ];

  let hasGovernance = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    if (monitoringKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasGovernance = true;
      break;
    }
  }

  if (!hasGovernance) {
    findings.push({
      asiId: 'ASI10',
      severity: 'info',
      message: 'ASI10: no monitoring, logging, or kill switch mechanisms mentioned in agent configs',
      fixHint: 'add monitoring/audit trail requirements and session limits to your agent config',
    });
    return { findings, deduction: 5 };
  }

  return { findings, deduction: 0 };
}
