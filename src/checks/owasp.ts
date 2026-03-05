import { join, relative } from 'node:path';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { isTextFile as utilIsTextFile, collectDirFiles as utilCollectDirFiles } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Agent config file targets ─────────────────────────────────────────────────

const AGENT_CONFIG_TARGETS = [
  '.claude',                              // dir: settings.json, commands/, etc.
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.cursor',                              // dir: settings.json, mcp.json
  '.github/copilot-instructions.md',
  '.mcp',                                 // dir
  'mcp.json',
  '.aider.conf.yml',
  '.continue',                            // dir
  '.roomodes',
  '.roo',                                 // dir
  'codex.md',
];

// Files that are specifically "instruction/config" text (not just any file)
const MCP_CONFIG_PATHS = [
  'mcp.json',
  '.mcp',
  '.cursor/mcp.json',
  '.claude/mcp.json',
];

// ── File helpers (delegated to util.ts) ──────────────────────────────────────

const isTextFile = utilIsTextFile;
const collectDirFiles = utilCollectDirFiles;

function collectAgentConfigFiles(cwd: string): string[] {
  const files: string[] = [];
  for (const target of AGENT_CONFIG_TARGETS) {
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
  return [...new Set(files)];
}

function collectMcpConfigFiles(cwd: string): string[] {
  const files: string[] = [];
  for (const target of MCP_CONFIG_PATHS) {
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
  return [...new Set(files)];
}

function readTextFile(filePath: string): string | null {
  if (!isTextFile(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Finding type ──────────────────────────────────────────────────────────────

interface OwaspFinding {
  asiId: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  fixHint?: string;
}

// ── ASI01 — Agent Goal Hijack (prompt injection) ──────────────────────────────

function checkASI01(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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

    // Check for raw URL fetch instructions without sanitization guidance
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (urlFetchPatterns.test(line)) {
        // Check surrounding context (5 lines) for sanitization
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

// ── ASI02 — Tool Misuse and Exploitation ──────────────────────────────────────

function checkASI02(cwd: string, mcpFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  let deduction = 0;

  for (const filePath of mcpFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const relPath = relative(cwd, filePath);

    // Check for tools/mcpServers entries
    const mcpConfig = parsed as Record<string, unknown>;
    const servers = (mcpConfig.mcpServers ?? mcpConfig.servers ?? {}) as Record<string, unknown>;

    for (const [toolName, toolConfig] of Object.entries(servers)) {
      const tool = toolConfig as Record<string, unknown>;
      const hasPermissions = tool.permissions != null || tool.allowedPaths != null || tool.restrictions != null;
      const hasEnv = tool.env != null;
      const args = Array.isArray(tool.args) ? (tool.args as string[]) : [];

      // Shell/exec tools without argument validation
      const isShellLike = ['bash', 'sh', 'zsh', 'powershell', 'cmd', 'exec'].some(s =>
        toolName.toLowerCase().includes(s) || args.some((a: string) => typeof a === 'string' && a.includes(s))
      );

      if (isShellLike && !hasPermissions) {
        findings.push({
          asiId: 'ASI02',
          severity: 'error',
          message: `ASI02: shell/exec tool "${toolName}" has no permission restrictions`,
          file: relPath,
          fixHint: 'add allowedPaths or restrictions to scope tool access',
        });
        deduction = Math.min(deduction + 10, 30);
      } else if (!hasPermissions && !hasEnv) {
        findings.push({
          asiId: 'ASI02',
          severity: 'warning',
          message: `ASI02: MCP tool "${toolName}" has no permission restrictions or path scoping`,
          file: relPath,
          fixHint: 'scope MCP tools with allowedPaths, permissions, or restrictions fields',
        });
        deduction = Math.min(deduction + 10, 30);
      }
    }

    // Check allowedTools in settings files
    if (typeof mcpConfig.allowedTools === 'string' && mcpConfig.allowedTools.includes('*')) {
      findings.push({
        asiId: 'ASI02',
        severity: 'warning',
        message: 'ASI02: allowedTools contains wildcard — overly broad tool access',
        file: relPath,
        fixHint: 'enumerate specific allowed tools instead of using wildcards',
      });
      deduction = Math.min(deduction + 10, 30);
    }
    if (Array.isArray(mcpConfig.allowedTools)) {
      const hasWildcard = (mcpConfig.allowedTools as unknown[]).some(t => t === '*' || t === '**');
      if (hasWildcard) {
        findings.push({
          asiId: 'ASI02',
          severity: 'warning',
          message: 'ASI02: allowedTools contains wildcard — overly broad tool access',
          file: relPath,
          fixHint: 'enumerate specific allowed tools instead of using wildcards',
        });
        deduction = Math.min(deduction + 10, 30);
      }
    }
  }

  // Also check .claude/settings.json for allowedTools wildcards
  const claudeSettings = join(cwd, '.claude', 'settings.json');
  if (existsSync(claudeSettings)) {
    const content = readTextFile(claudeSettings);
    if (content) {
      try {
        const settings = JSON.parse(content) as Record<string, unknown>;
        if (Array.isArray(settings.allowedTools)) {
          const tools = settings.allowedTools as unknown[];
          const hasWildcard = tools.some(t => t === '*' || t === '**' || (typeof t === 'string' && t.endsWith(':*')));
          if (hasWildcard) {
            findings.push({
              asiId: 'ASI02',
              severity: 'warning',
              message: 'ASI02: .claude/settings.json allowedTools contains wildcard pattern',
              file: '.claude/settings.json',
              fixHint: 'enumerate specific allowed tools instead of using wildcards',
            });
            deduction = Math.min(deduction + 10, 30);
          }
        }
      } catch { /* skip */ }
    }
  }

  return { findings, deduction };
}

// ── ASI03 — Identity and Privilege Abuse ──────────────────────────────────────

function checkASI03(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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

    // Check for least-privilege mentions
    if (leastPrivKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasLeastPrivMention = true;
    }

    // Check for .env file references in instruction files (not in .env themselves)
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

    // Check for hardcoded credentials
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

      // Sudo/root patterns
      if (sudoPattern.test(line)) {
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

// ── ASI04 — Agentic Supply Chain Vulnerabilities ──────────────────────────────

function checkASI04(cwd: string, mcpFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  let deduction = 0;

  const localhostPattern = /^(https?:\/\/)?localhost|^(https?:\/\/)?127\.|^(https?:\/\/)?0\.0\.0\.0/i;

  for (const filePath of mcpFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const relPath = relative(cwd, filePath);
    const mcpConfig = parsed as Record<string, unknown>;
    const servers = (mcpConfig.mcpServers ?? mcpConfig.servers ?? {}) as Record<string, unknown>;

    for (const [toolName, toolConfig] of Object.entries(servers)) {
      const tool = toolConfig as Record<string, unknown>;
      const url = typeof tool.url === 'string' ? tool.url : null;
      const command = typeof tool.command === 'string' ? tool.command : null;
      const version = typeof tool.version === 'string' ? tool.version : null;

      // External URL MCP server
      if (url && !localhostPattern.test(url)) {
        findings.push({
          asiId: 'ASI04',
          severity: 'warning',
          message: `ASI04: MCP server "${toolName}" points to external URL: ${url}`,
          file: relPath,
          fixHint: 'verify external MCP servers; prefer localhost/self-hosted; pin versions',
        });
        deduction += 10;
      }

      // Unpinned tool version
      if (command && !version) {
        // Check if npx command without pinned version
        if (/npx\s+[^@\s]+(?!\s*@)/.test(command) || (command === 'npx' && !version)) {
          const args = Array.isArray(tool.args) ? (tool.args as string[]) : [];
          const firstArg = args[0] as string | undefined;
          if (typeof firstArg === 'string' && !firstArg.includes('@') && !firstArg.startsWith('-')) {
            findings.push({
              asiId: 'ASI04',
              severity: 'warning',
              message: `ASI04: MCP tool "${toolName}" uses unpinned npx package "${firstArg}"`,
              file: relPath,
              fixHint: 'pin package versions (e.g. @scope/package@1.2.3) to prevent supply chain attacks',
            });
            deduction += 10;
          }
        }
      }
    }
  }

  // Check agent config files for unverified external references
  const allConfigFiles = collectAgentConfigFiles(cwd);
  const externalAgentPattern = /(?:install|use|run|execute)\s+(?:https?:\/\/[^\s"']+|npm\s+i(?:nstall)?\s+[^\s"']+)/i;
  const unpinnedNpmPattern = /npm\s+i(?:nstall)?\s+(?:@[^/]+\/)?[a-z][a-z0-9\-]*(?!\s*@[0-9])/i;

  for (const filePath of allConfigFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;
    const relPath = relative(cwd, filePath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (unpinnedNpmPattern.test(line) && !/pinned|verified|trusted/i.test(line)) {
        findings.push({
          asiId: 'ASI04',
          severity: 'info',
          message: 'ASI04: agent config references npm package without pinned version',
          file: relPath,
          line: i + 1,
          fixHint: 'pin npm package versions in agent instructions to prevent supply chain attacks',
        });
        deduction += 10;
        break; // One per file
      }
    }
  }

  return { findings, deduction };
}

// ── ASI05 — Unexpected Code Execution ────────────────────────────────────────

function checkASI05(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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
    const contentLower = content.toLowerCase();

    if (sandboxKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasSandboxMention = true;
    }
    if (codeApprovalKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasCodeApproval = true;
    }

    // Check for autoApprove or unrestricted execution patterns
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
    // Check if there's actually any exec-related content before penalizing
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

// ── ASI06 — Memory and Context Poisoning ─────────────────────────────────────

function checkASI06(cwd: string): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  let deduction = 0;

  const memoryPaths = [
    '.claude/memory',
    '.cursor/memory',
    'memory',
    '.aider.chat.history.md',
    '.continue/memory',
    'agent-memory',
    'context-store',
  ];

  const gitignorePath = join(cwd, '.gitignore');
  let gitignoreContent = '';
  try {
    gitignoreContent = readFileSync(gitignorePath, 'utf-8');
  } catch { /* no gitignore */ }

  for (const memPath of memoryPaths) {
    const full = join(cwd, memPath);
    if (!existsSync(full)) continue;

    const relPath = memPath;

    // Check if memory files are tracked by git (not in .gitignore)
    const isIgnored = gitignoreContent.includes(memPath) || gitignoreContent.includes(memPath.split('/')[0]);

    if (!isIgnored) {
      findings.push({
        asiId: 'ASI06',
        severity: 'warning',
        message: `ASI06: agent memory path "${relPath}" is not in .gitignore — could be poisoned via PR`,
        file: relPath,
        fixHint: 'add agent memory directories to .gitignore to prevent context poisoning via PRs',
      });
      deduction += 8;
    }
  }

  // Check for RAG/embedding configs without filtering mentions
  const ragPatterns = ['.continue/config.json', '.cursor/settings.json'];
  for (const ragPath of ragPatterns) {
    const full = join(cwd, ragPath);
    if (!existsSync(full)) continue;
    const content = readTextFile(full);
    if (!content) continue;

    const hasRag = /embed|rag|retrieval|vector|index/i.test(content);
    const hasFiltering = /filter|sanitize|validate|allowlist|blocklist/i.test(content);

    if (hasRag && !hasFiltering) {
      findings.push({
        asiId: 'ASI06',
        severity: 'warning',
        message: `ASI06: RAG/embedding config "${ragPath}" has no input filtering`,
        file: ragPath,
        fixHint: 'add input filtering and validation for RAG/embedding sources to prevent context poisoning',
      });
      deduction += 8;
    }
  }

  return { findings, deduction };
}

// ── ASI07 — Insecure Inter-Agent Communication ───────────────────────────────

function checkASI07(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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
    const contentLower = content.toLowerCase();

    const hasMultiAgent = multiAgentKeywords.some(kw => new RegExp(kw, 'i').test(content));
    if (hasMultiAgent) {
      isMultiAgentSetup = true;
      const relPath = relative(cwd, filePath);

      if (authKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
        hasAuthMention = true;
      }

      // Look for inter-agent communication patterns without auth
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

  // Only report if multi-agent setup is actually detected
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

// ── ASI08 — Cascading Failures ────────────────────────────────────────────────

function checkASI08(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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

// ── ASI09 — Human-Agent Trust Exploitation ────────────────────────────────────

function checkASI09(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  if (configFiles.length === 0) return { findings, deduction: 0 };

  const destructiveKeywords = ['delete', 'drop', 'remove', 'deploy', 'publish', 'push', 'rm ', 'truncate'];
  const approvalKeywords = [
    'confirm', 'approval', 'approve', 'ask.*before', 'human.*review', 'manual.*review',
    'permission', 'consent', 'verify.*before', 'check.*before', 'gate',
  ];

  let hasDestructiveOps = false;
  let hasApprovalGate = false;

  for (const filePath of configFiles) {
    const content = readTextFile(filePath);
    if (!content) continue;

    if (destructiveKeywords.some(kw => new RegExp(`\\b${kw}\\b`, 'i').test(content))) {
      hasDestructiveOps = true;
    }
    if (approvalKeywords.some(kw => new RegExp(kw, 'i').test(content))) {
      hasApprovalGate = true;
    }
  }

  // Check for autoApprove in settings
  const claudeSettings = join(cwd, '.claude', 'settings.json');
  if (existsSync(claudeSettings)) {
    const content = readTextFile(claudeSettings);
    if (content) {
      try {
        const settings = JSON.parse(content) as Record<string, unknown>;
        if (settings.autoApprove === true || (Array.isArray(settings.autoApprove) && (settings.autoApprove as unknown[]).length > 0)) {
          findings.push({
            asiId: 'ASI09',
            severity: 'warning',
            message: 'ASI09: autoApprove enabled in .claude/settings.json — destructive ops may run unattended',
            file: '.claude/settings.json',
            fixHint: 'disable autoApprove or restrict it to non-destructive operations only',
          });
          return { findings, deduction: 10 };
        }
      } catch { /* skip */ }
    }
  }

  if (hasDestructiveOps && !hasApprovalGate) {
    findings.push({
      asiId: 'ASI09',
      severity: 'warning',
      message: 'ASI09: agent config references destructive operations (delete/deploy/publish) without approval gates',
      fixHint: 'require explicit human confirmation before destructive operations (delete, deploy, publish)',
    });
    return { findings, deduction: 10 };
  }

  if (!hasApprovalGate) {
    findings.push({
      asiId: 'ASI09',
      severity: 'info',
      message: 'ASI09: no human approval gates mentioned in agent configs',
      fixHint: 'document which operations require human approval in your agent config',
    });
  }

  return { findings, deduction: 0 };
}

// ── ASI10 — Rogue Agents ─────────────────────────────────────────────────────

function checkASI10(cwd: string, configFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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
    checkASI04(cwd, mcpFiles),
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
