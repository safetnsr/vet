import { relative } from 'node:path';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI05 — Unexpected Code Execution ────────────────────────────────────────

export function checkASI05(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  if (configFiles.length === 0) return { findings, deduction: 0 };

  const unrestrictedExecPattern = /(?:allow|can|may|enabled?)\s+(?:to\s+)?(?:run|execute|exec|eval|shell)/i;
  const sandboxKeywords = ['sandbox', 'container', 'docker', 'isolated', 'restricted', 'approval', 'review before', 'confirm before'];
  const codeApprovalKeywords = ['review', 'approve', 'confirm', 'gate', 'human.?in.?the.?loop', 'ask before'];

  let hasSandboxMention = false;
  let hasCodeApproval = false;
  let hasUnrestrictedExec = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    if (sandboxKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasSandboxMention = true;
    }
    if (codeApprovalKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasCodeApproval = true;
    }

    const lines = content.split('\n');
    const relPath = relative(cwd, filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/autoApprove|auto.?approve/i.test(line) && !/false|disabled?|no\s+auto/i.test(line)) {
        findings.push({
          asiId: 'ASI05',
          severity: 'warning',
          message: 'ASI05: autoApprove pattern detected — code execution may proceed without human review',
          file: relPath,
          line: i + 1,
          fixHint: 'require human approval gates before executing generated code',
        });
        hasUnrestrictedExec = true;
      }

      if (unrestrictedExecPattern.test(line) && !sandboxKeywords.some(kw => new RegExp(kw, 'i').test(line))) {
        findings.push({
          asiId: 'ASI05',
          severity: 'info',
          message: 'ASI05: agent config allows code execution — ensure sandbox/approval controls are in place',
          file: relPath,
          line: i + 1,
          fixHint: 'add sandbox restrictions or approval gates for code execution',
        });
      }
    }
  }

  if (hasUnrestrictedExec || (!hasSandboxMention && !hasCodeApproval)) {
    const hasExecContent = configFiles.some(f => {
      const c = readTextFile(f);
      return c && /exec|shell|run|execute|eval|bash|python|node/i.test(c);
    });

    if (hasExecContent && !hasSandboxMention && !hasCodeApproval) {
      findings.push({
        asiId: 'ASI05',
        severity: 'warning',
        message: 'ASI05: agent config references code execution without sandbox or approval gates',
        fixHint: 'document sandbox restrictions and require approval for code execution in agent configs',
      });
      return { findings, deduction: 10 };
    }
  }

  return { findings, deduction: hasUnrestrictedExec ? 10 : 0 };
}
