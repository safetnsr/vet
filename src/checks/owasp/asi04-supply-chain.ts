import { relative } from 'node:path';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI04 — Agentic Supply Chain Vulnerabilities ──────────────────────────────

export function checkASI04(cwd: string, mcpFiles: string[], agentConfigFiles: string[]): { findings: OwaspFinding[]; deduction: number } {
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

      if (command && !version) {
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

  const unpinnedNpmPattern = /npm\s+i(?:nstall)?\s+(?:@[^/]+\/)?[a-z][a-z0-9\-]*(?!\s*@[0-9])/i;

  for (const filePath of agentConfigFiles) {
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
        break;
      }
    }
  }

  return { findings, deduction };
}
