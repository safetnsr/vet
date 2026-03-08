import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { CheckResult, Issue } from '../types.js';
import { readFile, fileExists } from '../util.js';

// ── Sensitive directories that trigger DANGER if MCP server writes there ──
const SENSITIVE_DIRS = [
  '~/.ssh',
  '~/.aws',
  '/etc',
  '/var/www',
];

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function isSensitiveDir(p: string): boolean {
  const expanded = expandHome(p);
  return SENSITIVE_DIRS.some(d => {
    const expandedSensitive = expandHome(d);
    return expanded === expandedSensitive || expanded.startsWith(expandedSensitive + '/');
  });
}

function isOutsideCwd(p: string, cwd: string): boolean {
  const expanded = expandHome(p);
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const resolvedCwd = resolve(cwd);
  return !abs.startsWith(resolvedCwd + '/') && abs !== resolvedCwd;
}

/** Score helper */
function applyPenalty(score: number, severity: 'error' | 'warning' | 'info'): number {
  const penalties = { error: 30, warning: 15, info: 5 };
  return Math.max(0, score - penalties[severity]);
}

// ── A. Scan .claude/settings.json ─────────────────────────────────────────
function checkSettingsJson(cwd: string, issues: Issue[]): void {
  const settingsPath = join(cwd, '.claude', 'settings.json');
  if (!fileExists(settingsPath)) return;

  const raw = readFile(settingsPath);
  if (!raw) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch {
    issues.push({
      severity: 'warning',
      message: '.claude/settings.json is not valid JSON — cannot audit permissions',
      file: '.claude/settings.json',
      fixable: false,
    });
    return;
  }

  // allowedTools containing bare "Bash" or "Bash(*)"
  const allowedTools = settings.allowedTools;
  if (Array.isArray(allowedTools)) {
    for (const tool of allowedTools) {
      if (typeof tool === 'string') {
        if (tool === 'Bash' || tool === 'Bash(*)') {
          issues.push({
            severity: 'error',
            message: `allowedTools contains "${tool}" without path restrictions — unrestricted shell access`,
            file: '.claude/settings.json',
            fixable: true,
            fixHint: `Replace "${tool}" with specific allowed commands, e.g. "Bash(npm run *)"`,
          });
        }
      }
    }
  }

  // permissions.allow with wildcards
  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (permissions && Array.isArray(permissions.allow)) {
    for (const rule of permissions.allow) {
      if (typeof rule === 'string' && (rule === 'Bash(*)' || rule === '**' || rule.includes('**'))) {
        issues.push({
          severity: 'error',
          message: `permissions.allow contains wildcard "${rule}" — grants broad access`,
          file: '.claude/settings.json',
          fixable: true,
          fixHint: 'Remove wildcard rules and enumerate specific allowed operations',
        });
      }
    }
  }

  // defaultMode: "bypassPermissions"
  if (settings.defaultMode === 'bypassPermissions') {
    issues.push({
      severity: 'error',
      message: 'defaultMode is "bypassPermissions" — skips all permission checks',
      file: '.claude/settings.json',
      fixable: true,
      fixHint: 'Remove defaultMode or set to "default"',
    });
  }

  // No blockedTools or deny list
  const hasBlockedTools = Array.isArray(settings.blockedTools) && (settings.blockedTools as unknown[]).length > 0;
  const hasDenyList = permissions && Array.isArray(permissions.deny) && (permissions.deny as unknown[]).length > 0;
  if (!hasBlockedTools && !hasDenyList) {
    issues.push({
      severity: 'warning',
      message: 'No blockedTools or deny list defined — all unlisted tools remain available',
      file: '.claude/settings.json',
      fixable: true,
      fixHint: 'Add blockedTools: ["Bash", "Write"] to restrict dangerous operations',
    });
  }

  // ── B. MCP server configs ────────────────────────────────────────────────
  checkMcpServers(cwd, settings, '.claude/settings.json', issues);
}

// ── B. MCP server analysis ─────────────────────────────────────────────────
function checkMcpServers(
  cwd: string,
  settings: Record<string, unknown>,
  filePath: string,
  issues: Issue[],
): void {
  const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') return;

  for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
    if (typeof serverConfig !== 'object' || serverConfig === null) continue;
    const config = serverConfig as Record<string, unknown>;

    // Check server args for filesystem paths
    const args = config.args;
    const isFilesystemServer =
      (typeof config.command === 'string' && config.command.includes('filesystem')) ||
      (Array.isArray(args) && args.some((a: unknown) => typeof a === 'string' && a.includes('filesystem')));

    // Detect if server is read-only
    const isReadOnly = Array.isArray(args) && args.some(
      (a: unknown) => typeof a === 'string' && (a === '--read-only' || a === 'readonly' || a === '--readonly'),
    );

    // Collect root paths from args
    const rootPaths: string[] = [];
    if (Array.isArray(args)) {
      for (const arg of args) {
        if (typeof arg === 'string' && !arg.startsWith('-') && (arg.startsWith('/') || arg.startsWith('~/') || arg.startsWith('.'))) {
          rootPaths.push(arg);
        }
      }
    }
    // Also check explicit root config
    if (typeof config.root === 'string') {
      rootPaths.push(config.root);
    }
    if (Array.isArray(config.roots)) {
      for (const r of config.roots) {
        if (typeof r === 'string') rootPaths.push(r);
      }
    }

    if (rootPaths.length === 0) {
      // No path restrictions at all
      issues.push({
        severity: 'warning',
        message: `MCP server "${serverName}" has no explicit path restrictions`,
        file: filePath,
        fixable: true,
        fixHint: `Add root path restriction to "${serverName}" in mcpServers config`,
      });
      continue;
    }

    for (const rootPath of rootPaths) {
      // Check sensitive directory access
      if (isSensitiveDir(rootPath)) {
        issues.push({
          severity: 'error',
          message: `MCP server "${serverName}" has access to sensitive directory: ${rootPath}`,
          file: filePath,
          fixable: true,
          fixHint: `Remove sensitive path "${rootPath}" from MCP server config`,
        });
        continue;
      }

      // Check if root is outside cwd and not read-only
      if (isOutsideCwd(rootPath, cwd) && !isReadOnly) {
        issues.push({
          severity: 'error',
          message: `MCP server "${serverName}" has write access outside project dir: ${rootPath}`,
          file: filePath,
          fixable: true,
          fixHint: `Restrict to project directory or add --read-only flag`,
        });
      }
    }
  }
}

// ── C. CLAUDE.md and AGENTS.md text heuristics ────────────────────────────
const DANGEROUS_PHRASES = [
  /full\s+access/i,
  /unrestricted/i,
  /\bsudo\b/i,
  /skip\s+confirmation/i,
  /no\s+restrictions/i,
];

function checkMarkdownFiles(cwd: string, issues: Issue[]): void {
  for (const filename of ['CLAUDE.md', 'AGENTS.md']) {
    const filePath = join(cwd, filename);
    if (!fileExists(filePath)) continue;

    const content = readFile(filePath);
    if (!content) continue;

    const lines = content.split('\n');
    for (const pattern of DANGEROUS_PHRASES) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          const matchText = lines[i].match(pattern)?.[0] ?? pattern.source;
          issues.push({
            severity: 'warning',
            message: `${filename} contains potentially dangerous instruction: "${matchText.trim()}"`,
            file: filename,
            line: i + 1,
            fixable: false,
            fixHint: `Review line ${i + 1} in ${filename} — ensure it doesn't grant unintended permissions`,
          });
          break; // one issue per pattern per file
        }
      }
    }
  }
}

// ── Main export ────────────────────────────────────────────────────────────
export function checkPermissions(cwd: string): CheckResult {
  const issues: Issue[] = [];

  checkSettingsJson(cwd, issues);
  checkMarkdownFiles(cwd, issues);

  // Score: start at 100, deduct per issue
  let score = 100;
  for (const issue of issues) {
    score = applyPenalty(score, issue.severity);
  }

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;

  let summary: string;
  if (issues.length === 0) {
    summary = 'no dangerous permission grants detected';
  } else if (errorCount > 0) {
    summary = `${errorCount} dangerous grant${errorCount !== 1 ? 's' : ''} detected — review before running agent`;
  } else {
    summary = `${warnCount} permission warning${warnCount !== 1 ? 's' : ''} — tighten config before agent session`;
  }

  return {
    name: 'permissions',
    score,
    maxScore: 100,
    issues,
    summary,
  };
}
