import { join } from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { CheckResult, Issue } from '../types.js';
import { c } from '../util.js';
import { cachedReadFile } from '../file-cache.js';

// ── Tiktoken lazy init ───────────────────────────────────────────────────────

import { encodingForModel } from 'js-tiktoken';

let _encoder: ReturnType<typeof encodingForModel> | null = null;

function getEncoder() {
  if (!_encoder) {
    _encoder = encodingForModel('gpt-4');
  }
  return _encoder;
}

function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'SOUL.md', '.cursorrules', 'codex.md'];
const CURSOR_RULES_DIR = join('.cursor', 'rules');
const MEMORY_DIR = 'memory';
const DAILY_DIR = join(MEMORY_DIR, 'daily');

const MODEL_COSTS: Record<string, number> = {
  opus: 15,    // $15 per MTok input
  sonnet: 3,   // $3 per MTok input
  haiku: 0.25, // $0.25 per MTok input
};

const TOKEN_THRESHOLD = 8000;
const BLOATED_FILE_THRESHOLD = 10000;

// ── Section parsing ──────────────────────────────────────────────────────────

interface Section {
  title: string;
  content: string;
  tokens: number;
  file: string;
}

function splitIntoSections(content: string, file: string): Section[] {
  const lines = content.split('\n');
  const sections: Section[] = [];
  let currentTitle = '(intro)';
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{2,3})\s+(.+)/);
    if (headerMatch) {
      // flush previous
      if (currentLines.length > 0) {
        const text = currentLines.join('\n');
        sections.push({ title: currentTitle, content: text, tokens: countTokens(text), file });
      }
      currentTitle = headerMatch[2].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // flush last
  if (currentLines.length > 0) {
    const text = currentLines.join('\n');
    sections.push({ title: currentTitle, content: text, tokens: countTokens(text), file });
  }

  return sections;
}

// ── File discovery ───────────────────────────────────────────────────────────

function discoverContextFiles(cwd: string): string[] {
  const files: string[] = [];

  for (const name of CONTEXT_FILES) {
    const full = join(cwd, name);
    if (existsSync(full)) files.push(full);
  }

  // memory/*.md (not daily/)
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

  // .cursor/rules
  const cursorDir = join(cwd, CURSOR_RULES_DIR);
  if (existsSync(cursorDir) && statSync(cursorDir).isDirectory()) {
    try {
      for (const entry of readdirSync(cursorDir)) {
        const full = join(cursorDir, entry);
        try {
          if (statSync(full).isFile()) files.push(full);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return files;
}

// ── Stale detection ──────────────────────────────────────────────────────────

function detectStaleSections(sections: Section[]): Set<string> {
  const stale = new Set<string>();
  const claudeDir = join(homedir(), '.claude', 'projects');

  if (!existsSync(claudeDir)) return stale;

  // Collect recent session log content
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let sessionContent = '';

  try {
    const projects = readdirSync(claudeDir);
    for (const project of projects) {
      const projectDir = join(claudeDir, project);
      try {
        if (!statSync(projectDir).isDirectory()) continue;
      } catch { continue; }

      try {
        const files = readdirSync(projectDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const full = join(projectDir, file);
          try {
            const stat = statSync(full);
            if (stat.mtimeMs < sevenDaysAgo) continue;
            sessionContent += readFileSync(full, 'utf-8') + '\n';
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { return stale; }

  if (!sessionContent) return stale;

  // Check each section: extract significant phrases and grep
  for (const section of sections) {
    if (section.title === '(intro)') continue;

    // Extract significant words from section content (skip short/generic)
    const words = section.content
      .replace(/[#`*_\-\[\](){}|]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4);

    // Take a sample of phrases to check
    const phrases = words.slice(0, 20);
    if (phrases.length === 0) continue;

    const found = phrases.some(phrase => sessionContent.includes(phrase));
    if (!found) {
      stale.add(`${section.file}::${section.title}`);
    }
  }

  return stale;
}

// ── Cost calculation ─────────────────────────────────────────────────────────

function calculateCost(tokens: number, model: string): number {
  const rate = MODEL_COSTS[model] || 3;
  return (tokens / 1_000_000) * rate;
}

function formatCost(cost: number): string {
  if (cost < 0.001) return `$${cost.toFixed(6)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

// ── CheckResult (for full vet scan) ──────────────────────────────────────────

export function checkContext(cwd: string): CheckResult {
  const files = discoverContextFiles(cwd);
  const issues: Issue[] = [];
  let score = 100;

  if (files.length === 0) {
    score -= 15;
    issues.push({
      severity: 'error',
      message: 'No agent context files found',
      fixable: false,
    });
    return {
      name: 'context',
      score: Math.max(0, score),
      maxScore: 100,
      issues,
      summary: 'no agent context files found',
    };
  }

  const allSections: Section[] = [];
  let totalTokens = 0;

  for (const filePath of files) {
    const content = cachedReadFile(filePath);
    if (!content) continue;

    const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
    const sections = splitIntoSections(content, relPath);
    allSections.push(...sections);

    const fileTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
    totalTokens += fileTokens;

    if (fileTokens > BLOATED_FILE_THRESHOLD) {
      issues.push({
        severity: 'warning',
        message: `Context file exceeds 10K tokens: ${relPath} (${fileTokens} tokens)`,
        file: relPath,
        fixable: false,
        fixHint: 'Split or trim this file to reduce token cost',
      });
      score -= 5;
    }
  }

  // Stale detection
  const staleSections = detectStaleSections(allSections);
  let staleDeduction = 0;
  let staleSavings = 0;
  for (const key of staleSections) {
    const [file, title] = key.split('::');
    const section = allSections.find(s => s.file === file && s.title === title);
    if (section) staleSavings += section.tokens;
    if (staleDeduction < 40) {
      issues.push({
        severity: 'warning',
        message: `Stale section: "${title}" in ${file}`,
        file,
        fixable: false,
        fixHint: 'Section not referenced in recent sessions — consider removing',
      });
      staleDeduction += 10;
    }
  }
  score -= Math.min(staleDeduction, 40);

  // Token threshold penalty
  if (totalTokens > TOKEN_THRESHOLD) {
    const over = totalTokens - TOKEN_THRESHOLD;
    const penalty = Math.min(Math.floor(over / 2000) * 5, 30);
    score -= penalty;
  }

  // Info issues
  issues.push({
    severity: 'info',
    message: `Total context: ${totalTokens} tokens across ${files.length} file${files.length !== 1 ? 's' : ''}`,
    fixable: false,
  });

  if (staleSavings > 0) {
    const savings = formatCost(calculateCost(staleSavings, 'sonnet'));
    issues.push({
      severity: 'info',
      message: `Potential savings: ${staleSavings} tokens (${savings}/call at sonnet rates) from removing stale sections`,
      fixable: false,
    });
  }

  return {
    name: 'context',
    score: Math.max(0, score),
    maxScore: 100,
    issues,
    summary: `${totalTokens} tokens in ${files.length} context file${files.length !== 1 ? 's' : ''}${staleSections.size > 0 ? `, ${staleSections.size} stale section${staleSections.size !== 1 ? 's' : ''}` : ''}`,
  };
}

// ── Subcommand output ────────────────────────────────────────────────────────

export async function runContextCommand(format: string, cwd: string): Promise<void> {
  const files = discoverContextFiles(cwd);

  if (files.length === 0) {
    if (format === 'json') {
      console.log(JSON.stringify({ files: [], sections: [], totalTokens: 0, costs: {}, stale: [], score: 0 }, null, 2));
    } else {
      console.log(`\n  ${c.bold}vet context${c.reset} — no agent context files found\n`);
    }
    return;
  }

  const allSections: Section[] = [];
  let totalTokens = 0;

  for (const filePath of files) {
    const content = cachedReadFile(filePath);
    if (!content) continue;

    const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
    const sections = splitIntoSections(content, relPath);
    allSections.push(...sections);
    totalTokens += sections.reduce((sum, s) => sum + s.tokens, 0);
  }

  const staleSections = detectStaleSections(allSections);

  if (format === 'json') {
    const result = {
      files: files.map(f => f.startsWith(cwd) ? f.slice(cwd.length + 1) : f),
      sections: allSections.map(s => ({
        file: s.file,
        title: s.title,
        tokens: s.tokens,
        stale: staleSections.has(`${s.file}::${s.title}`),
        costs: {
          opus: calculateCost(s.tokens, 'opus'),
          sonnet: calculateCost(s.tokens, 'sonnet'),
          haiku: calculateCost(s.tokens, 'haiku'),
        },
      })),
      totalTokens,
      costs: {
        opus: calculateCost(totalTokens, 'opus'),
        sonnet: calculateCost(totalTokens, 'sonnet'),
        haiku: calculateCost(totalTokens, 'haiku'),
      },
      stale: [...staleSections],
      staleSavingsTokens: allSections
        .filter(s => staleSections.has(`${s.file}::${s.title}`))
        .reduce((sum, s) => sum + s.tokens, 0),
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ASCII table output
  console.log(`\n  ${c.bold}vet context${c.reset} — agent context cost audit\n`);

  // Header
  const fileW = 30;
  const sectionW = 25;
  const tokenW = 8;
  const costW = 12;

  console.log(`  ${c.dim}${'─'.repeat(fileW + sectionW + tokenW + costW * 3 + 10)}${c.reset}`);
  console.log(`  ${pad('File', fileW)} ${pad('Section', sectionW)} ${padR('Tokens', tokenW)} ${padR('Opus', costW)} ${padR('Sonnet', costW)} ${padR('Haiku', costW)}`);
  console.log(`  ${c.dim}${'─'.repeat(fileW + sectionW + tokenW + costW * 3 + 10)}${c.reset}`);

  for (const s of allSections) {
    const isStale = staleSections.has(`${s.file}::${s.title}`);
    const staleMarker = isStale ? ` ${c.yellow}⚠ stale${c.reset}` : '';
    const file = truncate(s.file, fileW);
    const title = truncate(s.title, sectionW);

    console.log(`  ${pad(file, fileW)} ${pad(title, sectionW)} ${padR(String(s.tokens), tokenW)} ${padR(formatCost(calculateCost(s.tokens, 'opus')), costW)} ${padR(formatCost(calculateCost(s.tokens, 'sonnet')), costW)} ${padR(formatCost(calculateCost(s.tokens, 'haiku')), costW)}${staleMarker}`);
  }

  console.log(`  ${c.dim}${'─'.repeat(fileW + sectionW + tokenW + costW * 3 + 10)}${c.reset}`);
  console.log(`  ${pad(c.bold + 'Total' + c.reset, fileW)} ${pad('', sectionW)} ${padR(String(totalTokens), tokenW)} ${padR(formatCost(calculateCost(totalTokens, 'opus')), costW)} ${padR(formatCost(calculateCost(totalTokens, 'sonnet')), costW)} ${padR(formatCost(calculateCost(totalTokens, 'haiku')), costW)}`);
  console.log('');

  if (staleSections.size > 0) {
    const staleToks = allSections
      .filter(s => staleSections.has(`${s.file}::${s.title}`))
      .reduce((sum, s) => sum + s.tokens, 0);
    console.log(`  ${c.yellow}⚠ ${staleSections.size} stale section${staleSections.size !== 1 ? 's' : ''} detected${c.reset} — ${staleToks} tokens (${formatCost(calculateCost(staleToks, 'sonnet'))}/call at sonnet rates)`);
    console.log(`  ${c.dim}These sections weren't referenced in recent Claude sessions${c.reset}\n`);
  }
}

// ── String helpers ───────────────────────────────────────────────────────────

function pad(s: string, w: number): string {
  // Strip ANSI for length calculation
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, w - clean.length));
}

function padR(s: string, w: number): string {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '');
  return ' '.repeat(Math.max(0, w - clean.length)) + s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
