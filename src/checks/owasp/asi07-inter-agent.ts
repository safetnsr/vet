import { relative } from 'node:path';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI07 — Insecure Inter-Agent Communication ───────────────────────────────

export function checkASI07(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  let deduction = 0;

  const multiAgentKeywords = [
    'a2a', 'agent-to-agent', 'multi.?agent', 'subagent', 'sub-agent',
    'spawn agent', 'delegate', 'orchestrat', 'swarm', 'crew', 'autogen',
  ];
  const authKeywords = ['auth', 'token', 'signed', 'hmac', 'jwt', 'api.?key', 'verify', 'authenticated'];
  const encryptionKeywords = ['encrypt', 'tls', 'ssl', 'https', 'secure channel'];

  let isMultiAgentSetup = false;
  let hasAuthMention = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    const hasMultiAgent = multiAgentKeywords.some(kw => new RegExp(kw, 'i').test(content));
    if (hasMultiAgent) {
      isMultiAgentSetup = true;
      const relPath = relative(cwd, filePath);

      if (authKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
        hasAuthMention = true;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineHasMultiAgent = multiAgentKeywords.some(kw => new RegExp(kw, 'i').test(line));
        if (lineHasMultiAgent) {
          const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n');
          const hasLocalAuth = authKeywords.some(kw => new RegExp(kw, 'i').test(context));
          const hasLocalEncrypt = encryptionKeywords.some(kw => new RegExp(kw, 'i').test(context));

          if (!hasLocalAuth && !hasLocalEncrypt) {
            findings.push({
              asiId: 'ASI07',
              severity: 'warning',
              message: 'ASI07: inter-agent communication pattern without authentication or encryption context',
              file: relPath,
              line: i + 1,
              fixHint: 'ensure agent-to-agent channels use authentication tokens and encrypted transport',
            });
            deduction += 8;
            break;
          }
        }
      }
    }
  }

  if (isMultiAgentSetup && !hasAuthMention) {
    if (!findings.some(f => f.asiId === 'ASI07')) {
      findings.push({
        asiId: 'ASI07',
        severity: 'warning',
        message: 'ASI07: multi-agent setup detected but no authentication mentioned for inter-agent communication',
        fixHint: 'add authentication and authorization requirements for agent-to-agent communication',
      });
      deduction = Math.min(deduction + 8, 24);
    }
  }

  return { findings, deduction };
}
