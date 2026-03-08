import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { c } from '../util.js';
import { findLatestSession } from './receipt.js';
import type { CheckResult, Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface SessionEntry {
  type?: string;
  role?: string;
  content?: unknown;
  meta?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface CompactionEvent {
  messageIndex: number;
  summary: string;
  preContext: string[];
  droppedInstructions: string[];
  droppedFilePaths: string[];
  droppedIdentifiers: string[];
}

// ── Extraction helpers ───────────────────────────────────────────────────────

const FILE_PATH_RE = /(?:(?:\/[\w.@-]+)+(?:\/[\w.@-]+)*|[\w@-]+(?:\/[\w.@-]+)+)(?:\.\w+)?/g;
const IDENTIFIER_RE = /\b(?:[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z]+(?:_[a-z]+)+)\b/g;
const INSTRUCTION_RE = /(?:^|\.\s+)((?:always|never|must|don't|do not)\s[^.!?\n]{5,})/gim;

export function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_RE) || [];
  // Deduplicate and filter out very short ones
  return [...new Set(matches)].filter(m => m.includes('/') || m.includes('.'));
}

export function extractIdentifiers(text: string): string[] {
  const matches = text.match(IDENTIFIER_RE) || [];
  return [...new Set(matches)];
}

export function extractInstructions(text: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(INSTRUCTION_RE.source, INSTRUCTION_RE.flags);
  while ((match = re.exec(text)) !== null) {
    const instruction = match[1]!.trim();
    if (instruction.length > 10) results.push(instruction);
  }
  return [...new Set(results)];
}

function getTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (typeof b.text === 'string') return b.text;
          if (typeof b.content === 'string') return b.content;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

// ── Core parsing ─────────────────────────────────────────────────────────────

async function parseEntries(filePath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const rl = createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionEntry);
    } catch { /* skip malformed */ }
  }
  return entries;
}

function isCompactionEvent(entry: SessionEntry, index: number, hasExchanges: boolean): boolean {
  // Explicit type markers
  if (typeof entry.type === 'string' && /compact|summary/i.test(entry.type)) return true;
  if (entry.meta && typeof entry.meta.type === 'string' && /compact/i.test(entry.meta.type)) return true;

  // System message with long content after user/assistant exchanges
  if (entry.role === 'system' && hasExchanges) {
    const text = getTextContent(entry.content);
    if (text.length > 500) return true;
  }

  return false;
}

export function detectCompactions(entries: SessionEntry[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  let hasExchanges = false;
  let preContextTexts: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const role = entry.role ||
      ((entry as Record<string, unknown>).message
        ? ((entry as Record<string, unknown>).message as Record<string, unknown>)?.role as string | undefined
        : undefined);

    if (role === 'user' || role === 'assistant') {
      hasExchanges = true;
      const text = getTextContent(entry.content);
      if (text) preContextTexts.push(text);
    }

    if (isCompactionEvent(entry, i, hasExchanges)) {
      const summaryText = getTextContent(entry.content);
      const preText = preContextTexts.join('\n');

      // Extract keywords from pre-context
      const preFilePaths = extractFilePaths(preText);
      const preIdentifiers = extractIdentifiers(preText);
      const preInstructions = extractInstructions(preText);

      // Check which are absent from summary
      const summaryLower = summaryText.toLowerCase();

      const droppedFilePaths = preFilePaths.filter(fp => !summaryText.includes(fp));
      const droppedIdentifiers = preIdentifiers.filter(id => !summaryLower.includes(id.toLowerCase()));
      const droppedInstructions = preInstructions.filter(inst => {
        // Check if the core of the instruction is preserved
        const words = inst.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const preserved = words.filter(w => summaryLower.includes(w));
        return preserved.length < words.length * 0.5;
      });

      events.push({
        messageIndex: i,
        summary: summaryText.slice(0, 200),
        preContext: preContextTexts.slice(-5), // keep last 5 for context
        droppedInstructions,
        droppedFilePaths,
        droppedIdentifiers,
      });

      // Reset pre-context after compaction (summary becomes the new context)
      preContextTexts = [summaryText];
      hasExchanges = false;
    }
  }

  return events;
}

// ── Score calculation ────────────────────────────────────────────────────────

function calculateScore(events: CompactionEvent[]): { score: number; issues: Issue[] } {
  const issues: Issue[] = [];

  for (const event of events) {
    for (const inst of event.droppedInstructions) {
      issues.push({
        severity: 'error',
        message: `compaction #${event.messageIndex}: dropped instruction: "${inst.slice(0, 80)}"`,
        fixable: false,
      });
    }
    for (const fp of event.droppedFilePaths) {
      issues.push({
        severity: 'warning',
        message: `compaction #${event.messageIndex}: dropped file reference: ${fp}`,
        fixable: false,
      });
    }
    for (const id of event.droppedIdentifiers) {
      issues.push({
        severity: 'info',
        message: `compaction #${event.messageIndex}: dropped identifier: ${id}`,
        fixable: false,
      });
    }
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const infos = issues.filter(i => i.severity === 'info').length;

  const score = Math.max(0, 100 - (errors * 30 + warnings * 15 + infos * 5));

  return { score, issues };
}

// ── Check function (for full vet run) ────────────────────────────────────────

export async function checkCompact(cwd: string): Promise<CheckResult> {
  const sessionFile = findLatestSession();

  if (!sessionFile) {
    return {
      name: 'compact',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no claude session files found (~/.claude/projects/)', fixable: false }],
      summary: 'no session logs found',
    };
  }

  let entries: SessionEntry[];
  try {
    entries = await parseEntries(sessionFile);
  } catch {
    return {
      name: 'compact',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'warning', message: 'could not parse session file', fixable: false }],
      summary: 'session parse error',
    };
  }

  if (entries.length === 0) {
    return {
      name: 'compact',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'session file is empty', fixable: false }],
      summary: 'empty session file',
    };
  }

  const events = detectCompactions(entries);

  if (events.length === 0) {
    return {
      name: 'compact',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no compactions detected',
    };
  }

  const { score, issues } = calculateScore(events);

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const infos = issues.filter(i => i.severity === 'info').length;

  return {
    name: 'compact',
    score,
    maxScore: 100,
    issues,
    summary: `${events.length} compaction${events.length !== 1 ? 's' : ''}: ${errors} instructions, ${warnings} file refs, ${infos} identifiers dropped`,
  };
}

// ── Standalone subcommand ────────────────────────────────────────────────────

export async function runCompactCommand(format: 'ascii' | 'json', sessionPath?: string): Promise<void> {
  const filePath = sessionPath || findLatestSession();
  if (!filePath) {
    console.error('no claude session files found in ~/.claude/projects/');
    process.exit(1);
  }

  if (!fs.existsSync(filePath) && !sessionPath) {
    console.error('session file not found');
    process.exit(1);
  }

  const entries = await parseEntries(filePath);
  const events = detectCompactions(entries);
  const { score, issues } = calculateScore(events);

  if (format === 'json') {
    const result: CheckResult = {
      name: 'compact',
      score,
      maxScore: 100,
      issues,
      summary: events.length === 0
        ? 'no compactions detected'
        : `${events.length} compaction${events.length !== 1 ? 's' : ''} found`,
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // ASCII output
  const sessionId = path.basename(filePath, '.jsonl').slice(0, 30);
  console.log(`\n  ${c.bold}vet compact${c.reset} — compaction forensics\n`);
  console.log(`  session: ${sessionId}`);
  console.log(`  compactions found: ${events.length}\n`);

  if (events.length === 0) {
    console.log(`  ${c.green}no compactions detected${c.reset}\n`);
    console.log(`  score: 100/100\n`);
    return;
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    console.log(`  compaction ${i + 1} (message #${event.messageIndex}):`);

    for (const inst of event.droppedInstructions) {
      console.log(`    ${c.red}✗${c.reset} dropped instruction: "${inst.slice(0, 60)}"`);
    }
    for (const fp of event.droppedFilePaths) {
      console.log(`    ${c.yellow}⚠${c.reset} dropped file reference: ${fp}`);
    }
    for (const id of event.droppedIdentifiers) {
      console.log(`    ${c.dim}i${c.reset} dropped identifier: ${id}`);
    }

    if (event.droppedInstructions.length === 0 &&
        event.droppedFilePaths.length === 0 &&
        event.droppedIdentifiers.length === 0) {
      console.log(`    ${c.green}no drops detected${c.reset}`);
    }
    console.log('');
  }

  const totalInstructions = events.reduce((s, e) => s + e.droppedInstructions.length, 0);
  const totalFileRefs = events.reduce((s, e) => s + e.droppedFilePaths.length, 0);
  const totalIdentifiers = events.reduce((s, e) => s + e.droppedIdentifiers.length, 0);

  console.log(`  total drops: ${totalInstructions} instructions, ${totalFileRefs} file refs, ${totalIdentifiers} identifiers`);
  console.log(`  score: ${score}/100\n`);
}
