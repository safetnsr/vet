import { join, relative, dirname, basename } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { walkFiles, readFile, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

// ── Agent config filenames to discover ───────────────────────────────────────

export const AGENT_CONFIG_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  'codex.md',
  '.github/copilot-instructions.md',
  'cursor.json',
  '.cursor/rules',
  'copilot-instructions.md',
];

// ── Parse all agent config files present in cwd ──────────────────────────────

export function parseAgentConfigs(cwd: string): string[] {
  const found: string[] = [];
  for (const name of AGENT_CONFIG_FILES) {
    const full = join(cwd, name);
    if (existsSync(full)) {
      found.push(name);
    }
  }
  return found;
}

// ── Extract file/dir references from config file content ─────────────────────

export function extractRefs(content: string, cwd: string): string[] {
  const refs = new Set<string>();

  // Patterns to extract:
  // 1. Backtick paths: `path/to/file.ts` or `./path`
  const backtickPat = /`([^`\s]+)`/g;
  // 2. Inline code in markdown: single-line code with path-like content
  const codePat = /`([./][^`\s]+)`/g;
  // 3. Explicit path patterns in text: word/word or ./word or ~/word
  const pathPat = /(?:^|\s)((?:\.\/|\.\.\/|~\/)?(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]*[a-zA-Z0-9_-])/gm;
  // 4. Absolute paths starting with /
  const absPat = /(?:^|\s)(\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+)/gm;

  const extractFromPattern = (pat: RegExp) => {
    let match: RegExpExecArray | null;
    pat.lastIndex = 0;
    while ((match = pat.exec(content)) !== null) {
      const raw = match[1].trim();
      // Skip URLs
      if (raw.startsWith('http://') || raw.startsWith('https://') || raw.includes('://')) continue;
      // Skip if looks like a domain
      if (/^[a-z]+\.[a-z]{2,}/.test(raw) && !raw.includes('/')) continue;
      refs.add(raw);
    }
  };

  extractFromPattern(backtickPat);
  extractFromPattern(codePat);
  extractFromPattern(pathPat);
  extractFromPattern(absPat);

  // Filter to only refs that actually exist on disk (relative to cwd)
  const resolved: string[] = [];
  for (const ref of refs) {
    let resolvedPath: string;
    if (ref.startsWith('/')) {
      resolvedPath = ref;
    } else if (ref.startsWith('~/')) {
      resolvedPath = join(process.env.HOME || '/root', ref.slice(2));
    } else {
      resolvedPath = join(cwd, ref);
    }
    if (existsSync(resolvedPath)) {
      // Store as relative to cwd
      const rel = ref.startsWith('/') ? ref : ref;
      resolved.push(rel.replace(/^\.\//, ''));
    }
  }

  return [...new Set(resolved)];
}

// ── Visibility tier ──────────────────────────────────────────────────────────

export type VisibilityTier = 'config' | 'visible' | 'invisible';

export interface ClassifiedFile {
  path: string;
  tier: VisibilityTier;
}

// ── Classify all codebase files ───────────────────────────────────────────────

export function classifyFiles(
  cwd: string,
  configPaths: string[],
  refs: string[],
): ClassifiedFile[] {
  const allFiles = walkFiles(cwd);
  const configSet = new Set(configPaths);

  // Build a set of ref prefixes for directory matching
  const refSet = new Set(refs);

  // Also include files whose parent directory is referenced
  function isReferencedByRef(file: string): boolean {
    if (refSet.has(file)) return true;
    // Check if any ref is a directory prefix of this file
    for (const ref of refSet) {
      if (file.startsWith(ref + '/') || file.startsWith(ref.replace(/\/$/, '') + '/')) {
        return true;
      }
    }
    return false;
  }

  const classified: ClassifiedFile[] = [];
  for (const file of allFiles) {
    let tier: VisibilityTier;
    if (configSet.has(file)) {
      tier = 'config';
    } else if (isReferencedByRef(file)) {
      tier = 'visible';
    } else {
      tier = 'invisible';
    }
    classified.push({ path: file, tier });
  }

  // Also add config files that walkFiles might have missed (e.g. .github/copilot-instructions.md)
  for (const cp of configPaths) {
    if (!classified.find(f => f.path === cp)) {
      classified.push({ path: cp, tier: 'config' });
    }
  }

  return classified;
}

// ── Map result shape ──────────────────────────────────────────────────────────

export interface MapResult {
  config: string[];
  visible: string[];
  invisible: string[];
  stats: {
    total: number;
    visible_pct: number;
  };
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkMap(cwd: string): Promise<CheckResult & { mapData: MapResult }> {
  const issues: Issue[] = [];

  // Discover agent configs
  const configPaths = parseAgentConfigs(cwd);

  // Extract all refs from all config files
  const allRefs: string[] = [];
  for (const cp of configPaths) {
    const content = readFile(join(cwd, cp));
    if (content) {
      const refs = extractRefs(content, cwd);
      allRefs.push(...refs);
    }
  }
  const uniqueRefs = [...new Set(allRefs)];

  // Classify files
  const classified = classifyFiles(cwd, configPaths, uniqueRefs);

  const configFiles = classified.filter(f => f.tier === 'config').map(f => f.path);
  const visibleFiles = classified.filter(f => f.tier === 'visible').map(f => f.path);
  const invisibleFiles = classified.filter(f => f.tier === 'invisible').map(f => f.path);

  const total = classified.length;
  const visible = visibleFiles.length + configFiles.length;
  const visible_pct = total > 0 ? Math.round((visible / total) * 100) : 0;

  // Issues
  if (configPaths.length === 0) {
    issues.push({
      severity: 'warning',
      message: 'no agent config files found (CLAUDE.md, .cursorrules, etc.) — agent has no guided context',
      fixable: true,
      fixHint: 'run: npx @safetnsr/vet init',
    });
  }

  if (visible_pct < 20 && total > 0) {
    issues.push({
      severity: 'warning',
      message: `agent is mostly blind: only ${visible_pct}% of codebase is referenced in agent configs`,
      fixable: false,
    });
  }

  // Surface top invisible dirs as info
  const invisibleDirs = new Set<string>();
  for (const f of invisibleFiles) {
    const parts = f.split('/');
    if (parts.length > 1) invisibleDirs.add(parts[0]);
  }
  const topInvisibleDirs = [...invisibleDirs].slice(0, 5);
  if (topInvisibleDirs.length > 0 && invisibleFiles.length > 0) {
    issues.push({
      severity: 'info',
      message: `top invisible directories: ${topInvisibleDirs.join(', ')}`,
      fixable: false,
    });
  }

  const mapData: MapResult = {
    config: configFiles,
    visible: visibleFiles,
    invisible: invisibleFiles,
    stats: { total, visible_pct },
  };

  const summary = configPaths.length === 0
    ? `no agent config files — all ${total} files invisible`
    : `${visible_pct}% visible to agent (${visible}/${total} files)`;

  return {
    name: 'map',
    score: visible_pct,
    maxScore: 100,
    issues,
    summary,
    mapData,
  };
}

// ── Terminal renderer ─────────────────────────────────────────────────────────

export function renderMapReport(result: CheckResult & { mapData: MapResult }, asJson: boolean): string {
  const { mapData } = result;

  if (asJson) {
    return JSON.stringify({
      config: mapData.config,
      visible: mapData.visible,
      invisible: mapData.invisible,
      stats: mapData.stats,
    }, null, 2);
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${c.bold}vet map${c.reset} — agent visibility\n`);
  lines.push(`  ${c.dim}score:${c.reset}   ${c.bold}${mapData.stats.visible_pct}%${c.reset} visible to agent`);
  lines.push(`  ${c.dim}total:${c.reset}   ${mapData.stats.total} files`);
  lines.push('');

  // Config files tier
  if (mapData.config.length > 0) {
    lines.push(`  ${c.yellow}${c.bold}config files${c.reset} ${c.dim}(${mapData.config.length})${c.reset}`);
    for (const f of mapData.config.slice(0, 10)) {
      lines.push(`  ${c.yellow}●${c.reset} ${c.dim}${f}${c.reset}`);
    }
    if (mapData.config.length > 10) {
      lines.push(`  ${c.dim}  ... and ${mapData.config.length - 10} more${c.reset}`);
    }
    lines.push('');
  }

  // Visible files tier
  if (mapData.visible.length > 0) {
    lines.push(`  ${c.green}${c.bold}visible to agent${c.reset} ${c.dim}(${mapData.visible.length})${c.reset}`);
    for (const f of mapData.visible.slice(0, 15)) {
      lines.push(`  ${c.green}●${c.reset} ${f}`);
    }
    if (mapData.visible.length > 15) {
      lines.push(`  ${c.dim}  ... and ${mapData.visible.length - 15} more${c.reset}`);
    }
    lines.push('');
  }

  // Invisible dirs summary
  if (mapData.invisible.length > 0) {
    const invisibleDirs = new Map<string, number>();
    for (const f of mapData.invisible) {
      const parts = f.split('/');
      const dir = parts.length > 1 ? parts[0] : '(root)';
      invisibleDirs.set(dir, (invisibleDirs.get(dir) || 0) + 1);
    }
    const sortedDirs = [...invisibleDirs.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`  ${c.dim}${c.bold}invisible to agent${c.reset} ${c.dim}(${mapData.invisible.length} files)${c.reset}`);
    for (const [dir, count] of sortedDirs.slice(0, 8)) {
      lines.push(`  ${c.dim}○ ${dir}/ (${count} files)${c.reset}`);
    }
    if (sortedDirs.length > 8) {
      lines.push(`  ${c.dim}  ... and ${sortedDirs.length - 8} more directories${c.reset}`);
    }
    lines.push('');
  }

  // Issues
  for (const issue of result.issues) {
    const icon = issue.severity === 'warning' ? c.yellow + '⚠' : c.dim + 'ℹ';
    lines.push(`  ${icon}${c.reset} ${issue.message}`);
    if (issue.fixHint) lines.push(`    ${c.dim}→ ${issue.fixHint}${c.reset}`);
  }
  if (result.issues.length > 0) lines.push('');

  return lines.join('\n');
}
