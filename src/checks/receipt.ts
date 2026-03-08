import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { collectDirFiles } from '../util.js';
import { createInterface } from 'node:readline';
import type { CheckResult, Issue } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface SessionEntry {
  type?: string;
  role?: string;
  content?: unknown;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

export interface GroupedActions {
  session_id: string;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  files_modified: string[];
  files_deleted: string[];
  files_created: string[];
  commands_run: string[];
  urls_fetched: string[];
  packages_installed: string[];
}

export interface SessionReceipt {
  actions: GroupedActions;
  sha256: string;
  generated_at: string;
}

// ── Session file discovery ───────────────────────────────────────────────────

export function findSessionFiles(baseDir?: string): string[] {
  const dir = baseDir || path.join(process.env['HOME'] || '~', '.claude', 'projects');
  if (!fs.existsSync(dir)) return [];
  return collectDirFiles(dir).filter(f => f.endsWith('.jsonl')).sort();
}

export function findLatestSession(baseDir?: string): string | null {
  const files = findSessionFiles(baseDir);
  if (files.length === 0) return null;
  let latest = files[0]!;
  let latestMtime = fs.statSync(latest).mtimeMs;
  for (let i = 1; i < files.length; i++) {
    const mtime = fs.statSync(files[i]!).mtimeMs;
    if (mtime > latestMtime) { latest = files[i]!; latestMtime = mtime; }
  }
  return latest;
}

// ── JSONL parsing ────────────────────────────────────────────────────────────

export async function parseSessionFile(filePath: string): Promise<{ toolUses: ToolUseBlock[]; entries: SessionEntry[] }> {
  const toolUses: ToolUseBlock[] = [];
  const entries: SessionEntry[] = [];

  const rl = createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as SessionEntry;
      entries.push(entry);
      for (const content of [entry.content, entry.message?.content]) {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
              toolUses.push(block as ToolUseBlock);
            }
          }
        }
      }
    } catch { /* skip malformed */ }
  }

  return { toolUses, entries };
}

// ── Action grouper ───────────────────────────────────────────────────────────

function getFilePath(input: Record<string, unknown>): string | null {
  const p = (input['file_path'] || input['path'] || input['filePath'] || input['filename'] || '') as string;
  return p || null;
}

function extractPackages(cmd: string, packages: Set<string>): void {
  const npmM = cmd.match(/npm\s+(?:install|i|add)\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/);
  if (npmM) npmM[1]!.split(/\s+/).filter(p => !p.startsWith('-')).forEach(p => packages.add(p));
  const yarnM = cmd.match(/yarn\s+add\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/);
  if (yarnM) yarnM[1]!.split(/\s+/).filter(p => !p.startsWith('-')).forEach(p => packages.add(p));
  const pipM = cmd.match(/pip3?\s+install\s+([^\s&|;]+(?:\s+[^\s&|;-][^\s&|;]*)*)/);
  if (pipM) pipM[1]!.split(/\s+/).filter(p => !p.startsWith('-')).forEach(p => packages.add(p));
}

function extractUrls(cmd: string, urls: Set<string>): void {
  const matches = cmd.match(/https?:\/\/[^\s"'`<>|&;]+/g);
  if (matches) matches.forEach(u => urls.add(u));
}

function extractFileOps(cmd: string, deleted: Set<string>, created: Set<string>): void {
  const rmM = cmd.match(/(?:rm|trash)\s+(?:-[rf]*\s+)*([^\s&|;]+)/);
  if (rmM && /^(?:rm|trash)\b/.test(cmd)) deleted.add(rmM[1]!);
  const touchM = cmd.match(/(?:touch|mkdir)\s+(?:-[p]*\s+)*([^\s&|;]+)/);
  if (touchM) created.add(touchM[1]!);
}

function calculateDuration(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  try {
    const diff = new Date(end).getTime() - new Date(start).getTime();
    return isNaN(diff) ? null : Math.round(diff / 1000);
  } catch { return null; }
}

export function groupActions(toolUses: ToolUseBlock[], entries: SessionEntry[], sessionPath: string): GroupedActions {
  const filesModified = new Set<string>();
  const filesDeleted = new Set<string>();
  const filesCreated = new Set<string>();
  const commandsRun: string[] = [];
  const urlsFetched = new Set<string>();
  const packagesInstalled = new Set<string>();

  const timestamps = entries.map(e => e.timestamp).filter((t): t is string => typeof t === 'string').sort();

  for (const tool of toolUses) {
    const input = tool.input || {};
    switch (tool.name) {
      case 'Write': case 'write': case 'write_file': case 'create_file': {
        const fp = getFilePath(input); if (fp) filesCreated.add(fp); break;
      }
      case 'Edit': case 'edit': case 'edit_file': case 'str_replace_editor': {
        const fp = getFilePath(input); if (fp) filesModified.add(fp); break;
      }
      case 'Read': case 'read': case 'read_file': break;
      case 'exec': case 'execute': case 'bash': case 'terminal': case 'run_command': {
        const cmd = (input['command'] || input['cmd'] || '') as string;
        if (cmd) {
          commandsRun.push(cmd);
          extractPackages(cmd, packagesInstalled);
          extractUrls(cmd, urlsFetched);
          extractFileOps(cmd, filesDeleted, filesCreated);
        }
        break;
      }
      case 'web_fetch': case 'fetch': case 'http_request': case 'web_search': {
        const url = (input['url'] || input['query'] || '') as string;
        if (url) urlsFetched.add(url);
        break;
      }
      case 'browser': {
        const url = (input['targetUrl'] || input['url'] || '') as string;
        if (url) urlsFetched.add(url);
        break;
      }
    }
  }

  for (const f of filesCreated) filesModified.delete(f);

  return {
    session_id: path.basename(sessionPath, '.jsonl'),
    start_time: timestamps[0] || null,
    end_time: timestamps[timestamps.length - 1] || null,
    duration_seconds: calculateDuration(timestamps[0], timestamps[timestamps.length - 1]),
    files_modified: [...filesModified].sort(),
    files_deleted: [...filesDeleted].sort(),
    files_created: [...filesCreated].sort(),
    commands_run: commandsRun,
    urls_fetched: [...urlsFetched].sort(),
    packages_installed: [...packagesInstalled].sort(),
  };
}

// ── SHA256 + rendering ───────────────────────────────────────────────────────

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function renderReceiptText(actions: GroupedActions): string {
  const WIDTH = 46;
  const BORDER = '═'.repeat(WIDTH);
  const pad = (s: string) => (s.length >= WIDTH - 2 ? s.slice(0, WIDTH - 2) : s + ' '.repeat(WIDTH - 2 - s.length));
  const line = (s: string) => `║ ${pad(s)} ║`;
  const fmt = (d: string | null) => d ? new Date(d).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : 'unknown';
  const dur = (s: number | null) => s === null ? 'unknown' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;

  const lines: string[] = [];
  lines.push(`╔${BORDER}╗`);
  const title = 'AGENT SESSION RECEIPT';
  const leftPad = Math.floor((WIDTH - 2 - title.length) / 2);
  const rightPad = WIDTH - 2 - title.length - leftPad;
  lines.push(`║ ${' '.repeat(leftPad)}${title}${' '.repeat(rightPad)} ║`);
  lines.push(`╠${BORDER}╣`);
  lines.push(line(`Session:  ${actions.session_id.slice(0, 30)}`));
  lines.push(line(`Date:     ${fmt(actions.start_time)}`));
  lines.push(line(`Duration: ${dur(actions.duration_seconds)}`));
  lines.push(`╠${BORDER}╣`);

  const section = (title: string, items: string[]) => {
    lines.push(line(`${title} (${items.length})`));
    if (items.length === 0) lines.push(line('  (none)'));
    else for (const item of items) lines.push(line(`  ${item.slice(0, WIDTH - 6)}`));
    lines.push(line(''));
  };

  section('FILES CREATED', actions.files_created);
  section('FILES MODIFIED', actions.files_modified);
  section('FILES DELETED', actions.files_deleted);
  section('COMMANDS RUN', actions.commands_run);
  section('URLS FETCHED', actions.urls_fetched);
  section('PACKAGES INSTALLED', actions.packages_installed);

  const body = lines.join('\n');
  const sha256 = computeSha256(body);
  lines.push(`╠${BORDER}╣`);
  lines.push(line(`SHA256: ${sha256.slice(0, 36)}`));
  lines.push(`╚${BORDER}╝`);
  return lines.join('\n');
}

export function renderReceiptJson(actions: GroupedActions): SessionReceipt {
  const body = JSON.stringify(actions, null, 2);
  return { actions, sha256: computeSha256(body), generated_at: new Date().toISOString() };
}

// ── CheckResult adapter ──────────────────────────────────────────────────────

export async function checkReceipt(cwd: string): Promise<CheckResult> {
  const sessionFile = findLatestSession();
  const issues: Issue[] = [];

  if (!sessionFile) {
    return {
      name: 'receipt',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no claude session files found (~/.claude/projects/)', fixable: false }],
      summary: 'no session logs found',
    };
  }

  let toolUses: ToolUseBlock[] = [];
  let entries: SessionEntry[] = [];

  try {
    const parsed = await parseSessionFile(sessionFile);
    toolUses = parsed.toolUses;
    entries = parsed.entries;
  } catch {
    return {
      name: 'receipt',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'warning', message: 'could not parse session file', fixable: false }],
      summary: 'session parse error',
    };
  }

  const actions = groupActions(toolUses, entries, sessionFile);

  // Audit observations
  if (actions.commands_run.length > 20) {
    issues.push({ severity: 'info', message: `${actions.commands_run.length} commands run in last session — high activity`, fixable: false });
  }
  if (actions.files_deleted.length > 0) {
    issues.push({ severity: 'info', message: `${actions.files_deleted.length} file(s) deleted: ${actions.files_deleted.slice(0, 3).join(', ')}`, fixable: false });
  }
  if (actions.packages_installed.length > 0) {
    issues.push({ severity: 'info', message: `packages installed: ${actions.packages_installed.join(', ')}`, fixable: false });
  }
  if (actions.urls_fetched.length > 5) {
    issues.push({ severity: 'info', message: `${actions.urls_fetched.length} external URLs fetched`, fixable: false });
  }

  const totalActions =
    actions.files_created.length +
    actions.files_modified.length +
    actions.files_deleted.length +
    actions.commands_run.length;

  const sessionId = path.basename(sessionFile, '.jsonl').slice(0, 20);
  return {
    name: 'receipt',
    score: 10, // Receipt is informational — always full score
    maxScore: 100,
    issues,
    summary: `session ${sessionId}: ${totalActions} actions, ${actions.files_created.length} created, ${actions.files_modified.length} modified`,
  };
}

// ── Standalone subcommand output ─────────────────────────────────────────────

export async function runReceiptCommand(format: 'ascii' | 'json' = 'ascii'): Promise<void> {
  const sessionFile = findLatestSession();
  if (!sessionFile) {
    console.error('no claude session files found in ~/.claude/projects/');
    process.exit(1);
  }

  const { toolUses, entries } = await parseSessionFile(sessionFile);
  const actions = groupActions(toolUses, entries, sessionFile);

  if (format === 'json') {
    const receipt = renderReceiptJson(actions);
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(renderReceiptText(actions));
  }
}
