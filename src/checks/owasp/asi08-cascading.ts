import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI08 — Cascading Failures ────────────────────────────────────────────────

export function checkASI08(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  if (configFiles.length === 0) return { findings, deduction: 0 };

  const workflowKeywords = ['step', 'workflow', 'pipeline', 'sequence', 'chain', 'loop', 'iterate'];
  const errorHandlingKeywords = [
    'rollback', 'undo', 'revert', 'recover', 'retry', 'error handling', 'handle error',
    'circuit breaker', 'rate limit', 'max retries', 'timeout', 'fail safe', 'fallback',
    'on error', 'if it fails', 'if something goes wrong',
  ];

  let hasWorkflowContent = false;
  let hasErrorHandling = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    if (workflowKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasWorkflowContent = true;
    }
    if (errorHandlingKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasErrorHandling = true;
    }
  }

  if (hasWorkflowContent && !hasErrorHandling) {
    findings.push({
      asiId: 'ASI08',
      severity: 'warning',
      message: 'ASI08: multi-step workflow config lacks error handling, rollback, or recovery instructions',
      fixHint: 'add error handling instructions: rollback procedures, retry limits, and circuit breakers',
    });
    return { findings, deduction: 5 };
  }

  return { findings, deduction: 0 };
}
