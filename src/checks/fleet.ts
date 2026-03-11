import * as fs from 'node:fs';
import * as path from 'node:path';
import { c } from '../util.js';
import { findSessionFiles } from './receipt.js';
import type { CheckResult, Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type FleetStatus = 'OK' | 'SILENT_FAIL' | 'CONFLICT';

export interface FileTouch {
  session: string;
  action: 'write' | 'edit' | 'create' | 'delete';
  timestamp: string;
}

export interface FleetSession {
  id: string;
  file: string;
  startTime: string | null;
  endTime: string | null;
  durationMin: number;
  filesWritten: number;
  filesRead: number;
  toolCalls: number;
  status: FleetStatus;
  conflicts: string[];
}

export interface FleetResult {
  sessions: FleetSession[];
  conflicts: Map<string, string[]>;   // filepath → session ids
  silentFails: string[];              // session ids
  totalFiles: number;
  totalToolCalls: number;
}

// ── JSONL parsing ────────────────────────────────────────────────────────────

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

interface ParsedCall {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  action: 'write' | 'edit' | 'read' | 'bash' | 'other';
}

const WRITE_TOOLS = new Set(['Write', 'write_to_file', 'write', 'MultiEdit']);
const EDIT_TOOLS = new Set(['Edit', 'edit_file', 'edit']);
const READ_TOOLS = new Set(['Read', 'read_file', 'read', 'View']);

function classifyTool(name: string): 'write' | 'edit' | 'read' | 'bash' | 'other' {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (name === 'Bash' || name === 'bash' || name === 'execute_command') return 'bash';
  return 'other';
}

function extractFilePath(input: Record<string, unknown>): string | null {
  // Try common field names
  for (const key of ['file_path', 'path', 'filePath', 'filename']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  // For Edit tool, check old_string path
  if (typeof input['file'] === 'string') return input['file'] as string;
  return null;
}

function parseSessionJsonl(filePath: string, sinceMs: number | null): ParsedCall[] {
  const calls: ParsedCall[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return calls;
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = (entry['timestamp'] as string) || '';
    if (sinceMs && timestamp) {
      const entryTime = new Date(timestamp).getTime();
      if (!isNaN(entryTime) && entryTime < sinceMs) continue;
    }

    // Extract tool_use blocks from content arrays
    const contents: unknown[] = [];
    if (Array.isArray(entry['content'])) {
      contents.push(...(entry['content'] as unknown[]));
    }
    if (entry['message'] && typeof entry['message'] === 'object') {
      const msg = entry['message'] as Record<string, unknown>;
      if (Array.isArray(msg['content'])) {
        contents.push(...(msg['content'] as unknown[]));
      }
    }

    for (const block of contents) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;
      const toolName = (b['name'] as string) || '';
      const input = (b['input'] as Record<string, unknown>) || {};
      const action = classifyTool(toolName);
      const fp = extractFilePath(input);
      calls.push({ timestamp, toolName, filePath: fp, action });
    }
  }

  return calls;
}

// ── Core analysis ────────────────────────────────────────────────────────────

function parseSinceFlag(since?: string): number | null {
  if (!since) return null;
  // "8h", "24h", "1d", "30m"
  const match = since.match(/^(\d+)(h|d|m)$/i);
  if (match) {
    const val = parseInt(match[1]!, 10);
    const unit = match[2]!.toLowerCase();
    const ms = unit === 'h' ? val * 3600000 : unit === 'd' ? val * 86400000 : val * 60000;
    return Date.now() - ms;
  }
  // ISO date or timestamp
  const ts = new Date(since).getTime();
  return isNaN(ts) ? null : ts;
}

function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  // Shorten long UUIDs for display
  if (base.length > 20) return base.slice(0, 8);
  return base;
}

export function analyzeFleet(sessionsDir?: string, since?: string): FleetResult {
  const sinceMs = parseSinceFlag(since);
  const sessionFiles = findSessionFiles(sessionsDir);

  // Filter by mtime if --since
  const filteredFiles = sinceMs
    ? sessionFiles.filter(f => {
        try { return fs.statSync(f).mtimeMs >= sinceMs; } catch { return false; }
      })
    : sessionFiles;

  // Limit to last 20 sessions to avoid scanning entire history
  const recentFiles = filteredFiles.slice(-20);

  const fileTouches = new Map<string, FileTouch[]>();  // filepath → touches
  const sessions: FleetSession[] = [];

  for (const sessionFile of recentFiles) {
    const sid = sessionIdFromPath(sessionFile);
    const calls = parseSessionJsonl(sessionFile, sinceMs);

    if (calls.length === 0) {
      sessions.push({
        id: sid, file: sessionFile,
        startTime: null, endTime: null, durationMin: 0,
        filesWritten: 0, filesRead: 0, toolCalls: 0,
        status: 'OK', conflicts: [],
      });
      continue;
    }

    const timestamps = calls.filter(c => c.timestamp).map(c => c.timestamp);
    const startTime = timestamps.length > 0 ? timestamps[0]! : null;
    const endTime = timestamps.length > 0 ? timestamps[timestamps.length - 1]! : null;
    const durationMs = startTime && endTime
      ? new Date(endTime).getTime() - new Date(startTime).getTime()
      : 0;
    const durationMin = Math.round(durationMs / 60000);

    const writtenFiles = new Set<string>();
    const readFiles = new Set<string>();

    for (const call of calls) {
      if ((call.action === 'write' || call.action === 'edit') && call.filePath) {
        writtenFiles.add(call.filePath);
        // Track file touches for conflict detection
        const touches = fileTouches.get(call.filePath) || [];
        touches.push({ session: sid, action: call.action, timestamp: call.timestamp });
        fileTouches.set(call.filePath, touches);
      } else if (call.action === 'read' && call.filePath) {
        readFiles.add(call.filePath);
      }
    }

    // Silent fail: session had tool calls but zero writes
    const isSilentFail = calls.length > 3 && writtenFiles.size === 0;

    sessions.push({
      id: sid, file: sessionFile,
      startTime, endTime, durationMin,
      filesWritten: writtenFiles.size,
      filesRead: readFiles.size,
      toolCalls: calls.length,
      status: isSilentFail ? 'SILENT_FAIL' : 'OK',
      conflicts: [],
    });
  }

  // Detect cross-agent conflicts
  const conflicts = new Map<string, string[]>();
  for (const [fp, touches] of fileTouches) {
    const uniqueSessions = [...new Set(touches.map(t => t.session))];
    if (uniqueSessions.length >= 2) {
      conflicts.set(fp, uniqueSessions);
      // Mark sessions as conflicting
      for (const s of sessions) {
        if (uniqueSessions.includes(s.id) && s.status !== 'SILENT_FAIL') {
          s.status = 'CONFLICT';
          s.conflicts.push(fp);
        }
      }
    }
  }

  const silentFails = sessions.filter(s => s.status === 'SILENT_FAIL').map(s => s.id);

  return {
    sessions,
    conflicts,
    silentFails,
    totalFiles: fileTouches.size,
    totalToolCalls: sessions.reduce((sum, s) => sum + s.toolCalls, 0),
  };
}

// ── CheckResult integration ──────────────────────────────────────────────────

export function checkFleet(sessionsDir?: string, since?: string): CheckResult {
  const result = analyzeFleet(sessionsDir, since);
  const issues: Issue[] = [];

  for (const sid of result.silentFails) {
    issues.push({
      severity: 'error',
      message: `session ${sid}: SILENT FAIL — ran but produced 0 file changes`,
      fixable: false,
      fixHint: 'check session logs for errors or stuck loops',
    });
  }

  for (const [fp, sids] of result.conflicts) {
    issues.push({
      severity: 'warning',
      message: `file conflict: ${fp} — written by sessions: ${sids.join(', ')}`,
      file: fp,
      fixable: false,
      fixHint: 'review file for merge conflicts or overwritten changes',
    });
  }

  const score = Math.max(0,
    100
    - result.silentFails.length * 25
    - result.conflicts.size * 15
  );

  const summary = result.sessions.length === 0
    ? 'no session files found'
    : `${result.sessions.length} sessions — ${result.silentFails.length} silent fails, ${result.conflicts.size} file conflicts`;

  return { name: 'fleet', score, maxScore: 100, issues, summary };
}

// ── Subcommand output ────────────────────────────────────────────────────────

export async function runFleetCommand(
  format: string,
  sessionsDir?: string,
  since?: string,
): Promise<void> {
  const result = analyzeFleet(sessionsDir, since);

  if (format === 'json') {
    console.log(JSON.stringify({
      sessions: result.sessions.map(s => ({
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime,
        durationMin: s.durationMin,
        filesWritten: s.filesWritten,
        toolCalls: s.toolCalls,
        status: s.status,
        conflicts: s.conflicts,
      })),
      conflicts: Object.fromEntries(result.conflicts),
      silentFails: result.silentFails,
      totalFiles: result.totalFiles,
      totalToolCalls: result.totalToolCalls,
    }, null, 2));
    return;
  }

  console.log(`\n  ${c.bold}vet fleet${c.reset} — multi-agent session audit\n`);

  if (result.sessions.length === 0) {
    console.log(`  ${c.dim}no session files found${c.reset}`);
    console.log(`  ${c.dim}default path: ~/.claude/projects/*/sessions/*.jsonl${c.reset}\n`);
    return;
  }

  // Session table
  const padId = Math.max(8, ...result.sessions.map(s => s.id.length));
  const header = `  ${'SESSION'.padEnd(padId)}  ${'DURATION'.padEnd(8)}  ${'FILES'.padEnd(7)}  ${'CALLS'.padEnd(7)}  STATUS`;
  console.log(`  ${c.dim}${header}${c.reset}`);
  console.log(`  ${c.dim}${'─'.repeat(header.length)}${c.reset}`);

  for (const s of result.sessions) {
    const dur = s.durationMin > 0 ? `${s.durationMin}m` : '—';
    const files = String(s.filesWritten);
    const calls = String(s.toolCalls);
    const statusColor = s.status === 'SILENT_FAIL' ? c.red
      : s.status === 'CONFLICT' ? c.yellow
      : c.green;
    const statusIcon = s.status === 'SILENT_FAIL' ? '✗'
      : s.status === 'CONFLICT' ? '⚠'
      : '✓';
    console.log(
      `  ${s.id.padEnd(padId)}  ${dur.padEnd(8)}  ${files.padEnd(7)}  ${calls.padEnd(7)}  ${statusColor}${statusIcon} ${s.status}${c.reset}`
    );
  }
  console.log();

  // Conflicts
  if (result.conflicts.size > 0) {
    console.log(`  ${c.yellow}${c.bold}conflicts${c.reset}  ${c.dim}(same file written by multiple sessions)${c.reset}`);
    for (const [fp, sids] of result.conflicts) {
      console.log(`  ${c.yellow}⚠${c.reset} ${fp}  ${c.dim}— sessions: ${sids.join(', ')}${c.reset}`);
    }
    console.log();
  }

  // Silent failures
  if (result.silentFails.length > 0) {
    console.log(`  ${c.red}${c.bold}silent failures${c.reset}  ${c.dim}(sessions with 0 file changes)${c.reset}`);
    for (const sid of result.silentFails) {
      const s = result.sessions.find(x => x.id === sid);
      console.log(`  ${c.red}✗${c.reset} ${sid}  ${c.dim}— ${s?.toolCalls ?? 0} tool calls, 0 writes${c.reset}`);
    }
    console.log();
  }

  // Summary
  const ok = result.sessions.filter(s => s.status === 'OK').length;
  console.log(`  ${c.dim}summary: ${result.sessions.length} sessions. ${ok} ok, ${result.silentFails.length} silent fails, ${result.conflicts.size} conflicts.${c.reset}\n`);
}
