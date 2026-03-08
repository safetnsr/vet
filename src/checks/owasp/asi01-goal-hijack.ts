import { relative } from 'node:path';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI01 — Agent Goal Hijack (prompt injection) ──────────────────────────────

export function checkASI01(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  if (configFiles.length === 0) return { findings, deduction: 0 };

  const injectionKeywords = ['untrusted', 'injection', 'sanitize', 'validate input', 'input boundary', 'prompt injection', 'adversarial'];
  const urlFetchPatterns = /(?:fetch|curl|wget|http\.get|axios\.get|request\.get)\s*\(/i;
  const sanitizationKeywords = ['sanitize', 'escape', 'encode', 'validate', 'strip', 'clean'];

  let injectionAwarenessFound = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;
    const contentLower = content.toLowerCase();

    if (injectionKeywords.some(kw => contentLower.includes(kw))) {
      injectionAwarenessFound = true;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (urlFetchPatterns.test(line)) {
        const context = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 6)).join('\n').toLowerCase();
        const hasSanitization = sanitizationKeywords.some(kw => context.includes(kw));
        if (!hasSanitization) {
          findings.push({
            asiId: 'ASI01',
            severity: 'warning',
            message: 'ASI01: URL fetch instruction without sanitization guidance',
            file: relative(cwd, filePath),
            line: i + 1,
            fixHint: 'add guidance to sanitize/validate content fetched from external URLs',
          });
        }
      }
    }
  }

  if (!injectionAwarenessFound) {
    findings.push({
      asiId: 'ASI01',
      severity: 'warning',
      message: 'ASI01: no prompt injection awareness — agent configs do not mention input validation or untrusted content handling',
      fixHint: 'add instructions about handling untrusted input and prompt injection risks to your agent config',
    });
    return { findings, deduction: 15 };
  }

  return { findings, deduction: 0 };
}
