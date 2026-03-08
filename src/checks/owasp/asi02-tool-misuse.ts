import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI02 — Tool Misuse and Exploitation ──────────────────────────────────────

export function checkASI02(cwd: string, mcpFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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
    const mcpConfig = parsed as Record<string, unknown>;
    const servers = (mcpConfig.mcpServers ?? mcpConfig.servers ?? {}) as Record<string, unknown>;

    for (const [toolName, toolConfig] of Object.entries(servers)) {
      const tool = toolConfig as Record<string, unknown>;
      const hasPermissions = tool.permissions != null || tool.allowedPaths != null || tool.restrictions != null;
      const hasEnv = tool.env != null;
      const args = Array.isArray(tool.args) ? (tool.args as string[]) : [];

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
      } catch { /* intentional: skip unparseable settings */ }
    }
  }

  return { findings, deduction };
}
