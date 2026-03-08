import { relative } from 'node:path';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI03 — Identity and Privilege Abuse ──────────────────────────────────────

export function checkASI03(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  let deduction = 0;

  const credentialPatterns = [
    { pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*["']?[A-Za-z0-9\-_]{16,}/i, label: 'API key' },
    { pattern: /(?:secret|token|password|passwd|pwd)\s*[=:]\s*["']?[A-Za-z0-9\-_+/]{16,}/i, label: 'secret/token' },
    { pattern: /ssh-(?:rsa|ed25519|ecdsa)\s+[A-Za-z0-9+/]{20,}/i, label: 'SSH public key' },
    { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, label: 'private key' },
    { pattern: /(?:AWS|GOOGLE|AZURE)_[A-Z_]+\s*[=:]\s*["']?[A-Za-z0-9/+]{16,}/i, label: 'cloud credential' },
  ];

  const sudoPattern = /\bsudo\b|\bsu\s+-\b|run as root|elevated privileges|administrator rights/i;
  const leastPrivKeywords = ['least.?privilege', 'minimum.?permission', 'scoped credentials', 'credential scop', 'no credentials', 'avoid.*key', 'don.*t.*store.*key'];

  let hasLeastPrivMention = false;
  let hasEnvFileRef = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;
    const contentLower = content.toLowerCase();
    const relPath = relative(cwd, filePath);
    const normalizedPath = relPath.replace(/\\/g, '/');
    const isCiFile = normalizedPath.startsWith('.github/workflows/') || normalizedPath.startsWith('.circleci/') || normalizedPath.startsWith('.gitlab-ci');

    if (leastPrivKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasLeastPrivMention = true;
    }

    if (!filePath.endsWith('.env') && !filePath.includes('.env.')) {
      if (contentLower.includes('.env') && /load|source|read|require|import/i.test(content)) {
        if (!hasEnvFileRef) {
          findings.push({
            asiId: 'ASI03',
            severity: 'warning',
            message: 'ASI03: agent config references .env file — credentials may be accessible to agent',
            file: relPath,
            fixHint: 'ensure .env is not exposed to agent scope; use secret managers or scoped env vars',
          });
          deduction = Math.min(deduction + 15, 30);
          hasEnvFileRef = true;
        }
      }
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { pattern, label } of credentialPatterns) {
        if (pattern.test(line)) {
          findings.push({
            asiId: 'ASI03',
            severity: 'error',
            message: `ASI03: possible ${label} in agent config`,
            file: relPath,
            line: i + 1,
            fixHint: 'remove credentials from agent configs; use environment variables or secret managers',
          });
          deduction = Math.min(deduction + 15, 30);
        }
      }

      if (!isCiFile && sudoPattern.test(line)) {
        findings.push({
          asiId: 'ASI03',
          severity: 'warning',
          message: 'ASI03: agent config grants sudo/root access — privilege escalation risk',
          file: relPath,
          line: i + 1,
          fixHint: 'restrict agent to least-privilege — avoid sudo and root access in agent instructions',
        });
        deduction = Math.min(deduction + 15, 30);
      }
    }
  }

  if (!hasLeastPrivMention && configFiles.length > 0) {
    findings.push({
      asiId: 'ASI03',
      severity: 'info',
      message: 'ASI03: no mention of least-privilege or credential scoping in agent configs',
      fixHint: 'document credential access policies and least-privilege principles in agent config',
    });
  }

  return { findings, deduction };
}
