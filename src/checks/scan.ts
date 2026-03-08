import { join, relative } from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { isTextFile as utilIsTextFile, collectDirFiles as utilCollectDirFiles } from '../util.js';
import { cachedRead } from '../file-cache.js';
import type { CheckResult, Issue } from '../types.js';

// ── Pattern definitions ──────────────────────────────────────────────────────

interface ScanPattern {
  id: string;
  severity: 'critical' | 'high' | 'info';
  description: string;
  regex: RegExp;
}

const CRITICAL_PATTERNS: ScanPattern[] = [
  {
    id: 'base64-url',
    severity: 'critical',
    description: 'Base64-encoded URL in config — potential exfiltration endpoint',
    regex: /(?:aHR0c|data:text\/html;base64)/i,
  },
  {
    id: 'curl-pipe-shell',
    severity: 'critical',
    description: 'Download-and-execute pattern — remote code execution',
    regex: /(?:curl|wget)\s+[^\n|]*\|\s*(?:ba)?sh\b/i,
  },
  {
    id: 'pipe-to-shell',
    severity: 'critical',
    description: 'Pipe to shell interpreter — potential code execution',
    regex: /\|\s*(?:ba)?sh\b|\|\s*\beval\b/,
  },
  {
    id: 'command-substitution',
    severity: 'critical',
    description: 'Command substitution in config — potential injection vector',
    regex: /\$\([^)]+\)/,
  },
  {
    id: 'data-exfiltration',
    severity: 'critical',
    description: 'Data exfiltration pattern — sending local data to external URL',
    regex: /curl\s+[^\n]*(?:-[dFT]\s*@|--data-binary\s*@|--upload-file)|curl\s+[^\n]*\$(?:API_KEY|SECRET|TOKEN|PASSWORD)|nc\s+-[^\n]*\d+\.\d+/i,
  },
  {
    id: 'base64-exec',
    severity: 'critical',
    description: 'Base64-decoded payload piped to execution',
    regex: /base64\s+(?:-d|--decode)[^\n]*\|\s*(?:ba)?sh\b/i,
  },
  {
    id: 'powershell-download',
    severity: 'critical',
    description: 'PowerShell download cradle — remote code execution pattern',
    regex: /powershell.*downloadstring|iex.*webclient/i,
  },
];

const HIGH_PATTERNS: ScanPattern[] = [
  {
    id: 'prompt-injection',
    severity: 'high',
    description: 'Prompt injection — instructs agent to ignore previous instructions',
    regex: /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  },
  {
    id: 'system-prompt-override',
    severity: 'high',
    description: 'Attempts to override or replace the system prompt',
    regex: /system\s*prompt\s*(?:override|replace|ignore)/i,
  },
  {
    id: 'forget-prior',
    severity: 'high',
    description: 'Instructs agent to forget prior/previous context',
    regex: /forget\s+(?:all\s+)?(?:prior|previous|earlier)/i,
  },
  {
    id: 'env-var-exfiltration',
    severity: 'high',
    description: 'Env var referenced in URL context — potential key exfiltration',
    regex: /https?:\/\/[^\s"']*\$(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/i,
  },
  {
    id: 'permission-escalation',
    severity: 'high',
    description: 'Attempts to escalate permissions — sudo, chmod 777, chown root',
    regex: /sudo|chmod\s+777|chown\s+root/i,
  },
  {
    id: 'hidden-file-write',
    severity: 'high',
    description: 'Redirects output to hidden dotfiles or system directories',
    regex: />\s*~\/\.|>\s*\/etc\//i,
  },
];

const INFO_PATTERNS: ScanPattern[] = [
  {
    id: 'external-url',
    severity: 'info',
    description: 'External URL in config — often legitimate but worth reviewing',
    regex: /https?:\/\/[^\s"']+/,
  },
  {
    id: 'sensitive-path',
    severity: 'info',
    description: 'Reference to sensitive path (.ssh, .aws, .env, .gnupg)',
    regex: /\.ssh|\.gnupg|\.aws|\.env/,
  },
];

const ALL_SCAN_PATTERNS = [...CRITICAL_PATTERNS, ...HIGH_PATTERNS, ...INFO_PATTERNS];

// ── Config file targets ──────────────────────────────────────────────────────

const CONFIG_TARGETS = [
  '.claude', 'CLAUDE.md', 'AGENTS.md',
  '.cursorrules', '.cursor',
  '.github',
  'copilot-instructions.md',
  '.aider.conf.yml', '.aider',
  '.continue',
  '.mcp', 'mcp.json', '.mcp.json',
  '.roomodes', '.roo',
];

// ── File helpers (delegated to util.ts) ──────────────────────────────────────

const isTextFile = utilIsTextFile;
const collectDirFiles = utilCollectDirFiles;

function collectConfigFiles(cwd: string): string[] {
  const files: string[] = [];

  for (const target of CONFIG_TARGETS) {
    const full = join(cwd, target);
    if (!existsSync(full)) continue;
    try {
      const s = statSync(full);
      if (s.isFile()) {
        files.push(full);
      } else if (s.isDirectory()) {
        files.push(...collectDirFiles(full));
      }
    } catch { /* skip */ }
  }

  // Copilot instructions
  const copilot = join(cwd, '.github', 'copilot-instructions.md');
  if (existsSync(copilot) && !files.includes(copilot)) {
    files.push(copilot);
  }

  return [...new Set(files)];
}

// ── Scan logic ───────────────────────────────────────────────────────────────

interface ScanFinding {
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'info';
  description: string;
}

/** Check if a line is inside a markdown code fence or inline code */
function isInCodeContext(lines: string[], lineIndex: number): boolean {
  const line = lines[lineIndex];
  // Check if the match is inside inline backticks on this line
  // Simple heuristic: line contains backtick-wrapped content with the pattern
  if (/`[^`]*\$\([^)]+\)[^`]*`/.test(line)) return true;

  // Check if we're inside a fenced code block (``` or ~~~)
  let inFence = false;
  for (let i = 0; i < lineIndex; i++) {
    if (/^```|^~~~/.test(lines[i].trim())) inFence = !inFence;
  }
  return inFence;
}

/** Check if a file is a CI/workflow file where shell commands are expected */
function isWorkflowFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return normalized.includes('.github/workflows/') ||
    normalized.includes('.circleci/') ||
    normalized.includes('.gitlab-ci') ||
    /Makefile|Dockerfile|Jenkinsfile/i.test(normalized);
}

function scanContent(content: string, relPath: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const lines = content.split('\n');
  const isWorkflow = isWorkflowFile(relPath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of ALL_SCAN_PATTERNS) {
      // Skip command-substitution checks in workflow files (shell commands are expected)
      if (pattern.id === 'command-substitution' && isWorkflow) continue;

      // Skip permission-escalation in CI workflow files (sudo apt-get etc. is standard)
      if (pattern.id === 'permission-escalation' && isWorkflow) continue;

      // Skip command-substitution in markdown code contexts
      if (pattern.id === 'command-substitution' && relPath.endsWith('.md') && isInCodeContext(lines, i)) continue;

      if (pattern.regex.test(line)) {
        pattern.regex.lastIndex = 0;
        findings.push({
          file: relPath,
          line: i + 1,
          severity: pattern.severity,
          description: pattern.description,
        });
      }
      if (pattern.regex.global) pattern.regex.lastIndex = 0;
    }

    // Special: base64 that decodes to URL
    const b64Matches = line.match(/[A-Za-z0-9+/]{20,}={0,2}/g);
    if (b64Matches) {
      for (const m of b64Matches) {
        try {
          const decoded = Buffer.from(m, 'base64').toString('utf-8');
          if (/https?:\/\//i.test(decoded) && !/[^\x00-\x7F]/.test(decoded)) {
            findings.push({
              file: relPath,
              line: i + 1,
              severity: 'critical',
              description: 'Base64 string decodes to HTTP URL — likely encoded exfiltration endpoint',
            });
            break;
          }
        } catch { /* skip */ }
      }
    }
  }

  return findings;
}

// ── CheckResult adapter ──────────────────────────────────────────────────────

export function checkScan(cwd: string): CheckResult {
  const configFiles = collectConfigFiles(cwd);
  const findings: ScanFinding[] = [];
  let filesScanned = 0;

  for (const filePath of configFiles) {
    if (!isTextFile(filePath)) continue;
    try {
      const content = cachedRead(filePath);
      const relPath = relative(cwd, filePath);
      filesScanned++;
      findings.push(...scanContent(content, relPath));
    } catch { /* skip */ }
  }

  const issues: Issue[] = findings.map(f => ({
    severity: f.severity === 'critical' ? 'error' : f.severity === 'high' ? 'warning' : 'info',
    message: f.description,
    file: f.file,
    line: f.line,
    fixable: false,
  }));

  const criticals = findings.filter(f => f.severity === 'critical').length;
  const highs = findings.filter(f => f.severity === 'high').length;
  const score = Math.max(0, Math.min(100, 100 - criticals * 40 - highs * 15));

  return {
    name: 'scan',
    score: Math.round(score),
    maxScore: 100,
    issues,
    summary: filesScanned === 0
      ? 'no agent config files found'
      : findings.length === 0
        ? `${filesScanned} config file${filesScanned !== 1 ? 's' : ''} scanned, clean`
        : `${findings.length} finding${findings.length !== 1 ? 's' : ''} in ${filesScanned} config file${filesScanned !== 1 ? 's' : ''}`,
  };
}
