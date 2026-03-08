import { join } from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { isTextFile, collectDirFiles } from '../../util.js';
import { cachedRead } from '../../file-cache.js';

// ── Agent config file targets ─────────────────────────────────────────────────

const AGENT_CONFIG_TARGETS = [
  '.claude',
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.cursor',
  '.github/copilot-instructions.md',
  '.mcp',
  'mcp.json',
  '.aider.conf.yml',
  '.continue',
  '.roomodes',
  '.roo',
  'codex.md',
];

const MCP_CONFIG_PATHS = [
  'mcp.json',
  '.mcp',
  '.cursor/mcp.json',
  '.claude/mcp.json',
];

// ── File helpers ──────────────────────────────────────────────────────────────

/** Collect files for a given list of target paths (files or directories). */
function collectConfigFiles(cwd: string, targets: string[]): string[] {
  const files: string[] = [];
  for (const target of targets) {
    const full = join(cwd, target);
    if (!existsSync(full)) continue;
    try {
      const s = statSync(full);
      if (s.isFile()) {
        files.push(full);
      } else if (s.isDirectory()) {
        files.push(...collectDirFiles(full));
      }
    } catch { /* intentional: resolver may fail on unreadable files */ }
  }
  return [...new Set(files)];
}

export function collectAgentConfigFiles(cwd: string): string[] {
  return collectConfigFiles(cwd, AGENT_CONFIG_TARGETS);
}

export function collectMcpConfigFiles(cwd: string): string[] {
  return collectConfigFiles(cwd, MCP_CONFIG_PATHS);
}

export function readTextFile(filePath: string): string | null {
  if (!isTextFile(filePath)) return null;
  try {
    return cachedRead(filePath);
  } catch { /* intentional: resolver may fail on unreadable files */ }
  return null;
}

// ── Finding type ──────────────────────────────────────────────────────────────

export interface OwaspFinding {
  asiId: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  fixHint?: string;
}
