import { join, resolve } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import type { CheckResult, Issue } from '../types.js';
import { readFile } from '../util.js';
import { detectWorkspacePackages } from './deps.js';

// ── Memory file targets ──────────────────────────────────────────────────────

const ROOT_FILES = ['CLAUDE.md', 'AGENTS.md', 'SOUL.md', '.cursorrules', 'codex.md'];
const MEMORY_DIR = 'memory';
const DAILY_DIR = join(MEMORY_DIR, 'daily');
const MAX_DAILY_FILES = 30;

// ── Tool categories for contradiction detection ─────────────────────────────

const TOOL_CATEGORIES: Record<string, RegExp[]> = {
  'test framework': [/\bvitest\b/i, /\bjest\b/i, /\bmocha\b/i, /\bnode:test\b/i, /\bava\b/i],
  'package manager': [/\bnpm\b/, /\byarn\b/, /\bpnpm\b/, /\bbun\b/],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function collectMemoryFiles(cwd: string): string[] {
  const files: string[] = [];

  // Root-level memory files
  for (const name of ROOT_FILES) {
    const full = join(cwd, name);
    if (existsSync(full)) files.push(full);
  }

  // memory/*.md
  const memDir = join(cwd, MEMORY_DIR);
  if (existsSync(memDir) && statSync(memDir).isDirectory()) {
    try {
      for (const entry of readdirSync(memDir)) {
        if (!entry.endsWith('.md')) continue;
        const full = join(memDir, entry);
        try {
          if (statSync(full).isFile()) files.push(full);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // memory/daily/*.md (capped)
  const dailyDir = join(cwd, DAILY_DIR);
  if (existsSync(dailyDir) && statSync(dailyDir).isDirectory()) {
    try {
      const entries = readdirSync(dailyDir).filter(e => e.endsWith('.md')).sort().reverse();
      for (const entry of entries.slice(0, MAX_DAILY_FILES)) {
        const full = join(dailyDir, entry);
        try {
          if (statSync(full).isFile()) files.push(full);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return files;
}

/** Extract @scope/package references */
function extractScopedPackages(content: string): { pkg: string; line: number }[] {
  const results: { pkg: string; line: number }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].matchAll(/@[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+/g);
    for (const m of matches) {
      results.push({ pkg: m[0], line: i + 1 });
    }
  }
  return results;
}

/** Extract file/dir path references */
function extractPaths(content: string): { path: string; line: number }[] {
  const results: { path: string; line: number }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines that are purely URLs
    // Match absolute paths
    const absMatches = line.matchAll(/(?:^|\s|["`'(])(\/((?:var|home|usr|etc|opt|tmp|root|srv|mnt)[^\s"'`),;]*))(?=[\s"'`),;]|$)/g);
    for (const m of absMatches) {
      const p = m[1].replace(/[.,:;)]+$/, '');
      if (p.startsWith('//') || p.includes('://')) continue;
      if (p.length < 4) continue;
      results.push({ path: p, line: i + 1 });
    }
    // Match relative paths starting with ./ or ../
    const relMatches = line.matchAll(/(?:^|\s|["`'(])(\.\.?\/[^\s"'`),;]+)/g);
    for (const m of relMatches) {
      const p = m[1].replace(/[.,:;)]+$/, '');
      if (p.includes('://')) continue;
      results.push({ path: p, line: i + 1 });
    }
  }
  return results;
}

/** Extract tool mentions per category */
function extractToolMentions(content: string, fileName: string): Map<string, { tool: string; file: string; line: number }[]> {
  const mentions = new Map<string, { tool: string; file: string; line: number }[]>();
  const lines = content.split('\n');

  for (const [category, patterns] of Object.entries(TOOL_CATEGORIES)) {
    for (let i = 0; i < lines.length; i++) {
      for (const regex of patterns) {
        if (regex.test(lines[i])) {
          const toolMatch = lines[i].match(regex);
          if (toolMatch) {
            const existing = mentions.get(category) || [];
            existing.push({ tool: toolMatch[0].toLowerCase(), file: fileName, line: i + 1 });
            mentions.set(category, existing);
          }
        }
      }
    }
  }
  return mentions;
}

/** Count meaningful fact claims in a file */
function countFacts(content: string): number {
  let count = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('```')) continue;
    // A "fact" is a line with at least some substantive content
    if (trimmed.length > 15 && /[a-zA-Z]/.test(trimmed)) {
      // Contains a keyword-like pattern (assignment, instruction, reference)
      if (/[:=→\->]|use |stack|requires?|install|run |npm |config|version|path|file|dir|tool/i.test(trimmed)) {
        count++;
      }
    }
  }
  return count;
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkMemory(cwd: string): CheckResult {
  const memoryFiles = collectMemoryFiles(cwd);
  const issues: Issue[] = [];
  let deductions = 0;

  if (memoryFiles.length === 0) {
    return {
      name: 'memory',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no agent memory files found',
    };
  }

  // Load package.json deps
  const pkgPath = join(cwd, 'package.json');
  const allDeps = new Set<string>();
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      // Include the package's own name
      if (pkg.name) allDeps.add(pkg.name);
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        if (pkg[key]) {
          for (const name of Object.keys(pkg[key])) {
            allDeps.add(name);
          }
        }
      }
    } catch { /* skip */ }
  }

  // Include workspace package names
  const workspacePackages = detectWorkspacePackages(cwd);
  for (const name of workspacePackages) allDeps.add(name);

  // Collect all tool mentions across files for contradiction detection
  const globalToolMentions = new Map<string, { tool: string; file: string; line: number }[]>();

  for (const filePath of memoryFiles) {
    const content = readFile(filePath);
    if (!content) continue;

    const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;

    // 1. Stale package references
    if (allDeps.size > 0) {
      const pkgRefs = extractScopedPackages(content);
      for (const { pkg, line } of pkgRefs) {
        if (!allDeps.has(pkg)) {
          issues.push({
            severity: 'warning',
            message: `Stale package: ${pkg} not in package.json`,
            file: relPath,
            line,
            fixable: false,
            fixHint: 'Remove or update this reference',
          });
          deductions += 10;
        }
      }
    }

    // 2. Broken path references
    const pathRefs = extractPaths(content);
    for (const { path: p, line } of pathRefs) {
      // Skip ../  references — they point to sibling repos and can't be validated locally
      if (p.startsWith('../')) continue;
      const resolved = p.startsWith('/') ? p : resolve(cwd, p);
      if (!existsSync(resolved)) {
        issues.push({
          severity: 'error',
          message: `Broken path reference: ${p}`,
          file: relPath,
          line,
          fixable: false,
          fixHint: 'Remove or update this path reference',
        });
        deductions += 15;
      }
    }

    // 3. Collect tool mentions for contradiction check
    const toolMentions = extractToolMentions(content, relPath);
    for (const [category, mentions] of toolMentions) {
      const existing = globalToolMentions.get(category) || [];
      existing.push(...mentions);
      globalToolMentions.set(category, existing);
    }

    // 4. Bloat check
    if (content.length > 5000) {
      const factCount = countFacts(content);
      if (factCount < 3) {
        issues.push({
          severity: 'info',
          message: `Bloated memory file: ${content.length} chars but only ${factCount} fact claims`,
          file: relPath,
          line: 1,
          fixable: false,
          fixHint: 'Trim this file to only essential facts',
        });
        deductions += 5;
      }
    }
  }

  // 3. Contradiction detection
  for (const [category, mentions] of globalToolMentions) {
    const uniqueTools = new Map<string, { file: string; line: number }>();
    for (const m of mentions) {
      if (!uniqueTools.has(m.tool)) {
        uniqueTools.set(m.tool, { file: m.file, line: m.line });
      }
    }
    if (uniqueTools.size > 1) {
      const tools = [...uniqueTools.entries()];
      for (let i = 0; i < tools.length; i++) {
        for (let j = i + 1; j < tools.length; j++) {
          // Only flag if they're in different files
          if (tools[i][1].file !== tools[j][1].file) {
            issues.push({
              severity: 'warning',
              message: `Contradiction in ${category}: "${tools[i][0]}" in ${tools[i][1].file} vs "${tools[j][0]}" in ${tools[j][1].file}`,
              file: tools[i][1].file,
              line: tools[i][1].line,
              fixable: false,
              fixHint: `Standardize on one ${category} across memory files`,
            });
            deductions += 10;
          }
        }
      }
    }
  }

  const finalScore = Math.max(0, 100 - deductions);
  const issueCount = issues.length;

  return {
    name: 'memory',
    score: finalScore,
    maxScore: 100,
    issues,
    summary: issueCount === 0
      ? `${memoryFiles.length} memory file${memoryFiles.length !== 1 ? 's' : ''} scanned, clean`
      : `${issueCount} stale fact${issueCount !== 1 ? 's' : ''} found in agent memory files`,
  };
}
