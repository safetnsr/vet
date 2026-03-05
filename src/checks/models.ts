import { join } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { readFile, walkFiles } from '../util.js';

// Try to use @safetnsr/model-graveyard if installed (248 models, alias matching, YAML registry)
async function tryModelGraveyard(cwd: string): Promise<CheckResult | null> {
  try {
    const mod = await import(/* webpackIgnore: true */ '@safetnsr/model-graveyard' as string);
    if (typeof mod.scan !== 'function') return null;

    const report = await mod.scan(cwd);
    const issues: Issue[] = [];

    for (const match of report.matches) {
      if (!match.model) continue;
      if (match.model.status === 'deprecated' || match.model.status === 'eol') {
        issues.push({
          severity: 'error',
          message: `${match.model.status} model "${match.raw}" in ${match.file}:${match.line}${match.model.successor ? ` — use "${match.model.successor}"` : ''}`,
          file: match.file,
          line: match.line,
          fixable: !!match.model.successor,
          fixHint: match.model.successor ? `replace "${match.raw}" with "${match.model.successor}"` : undefined,
        });
      }
    }

    const score = Math.max(0, 100 - issues.length * 20);

    return {
      name: 'models',
      score: Math.min(100, score),
      maxScore: 100,
      issues,
      summary: issues.length === 0
        ? `${report.filesScanned} files scanned (via model-graveyard) — all current`
        : `${issues.length} deprecated model${issues.length > 1 ? 's' : ''} (via model-graveyard)`,
    };
  } catch {
    return null;
  }
}

// Built-in fallback: inline registry, basic string matching
const SUNSET_MODELS: Record<string, { replacement: string; sunset?: string }> = {
  'gpt-3.5-turbo': { replacement: 'gpt-4o-mini', sunset: '2025-06' },
  'gpt-4-turbo': { replacement: 'gpt-4o', sunset: '2025-04' },
  'gpt-4-turbo-preview': { replacement: 'gpt-4o', sunset: '2025-04' },
  'gpt-4-0314': { replacement: 'gpt-4o', sunset: '2024-06' },
  'gpt-4-0613': { replacement: 'gpt-4o', sunset: '2025-06' },
  'gpt-4-32k': { replacement: 'gpt-4o', sunset: '2025-06' },
  'text-davinci-003': { replacement: 'gpt-4o-mini', sunset: '2024-01' },
  'code-davinci-002': { replacement: 'gpt-4o', sunset: '2024-01' },
  'text-embedding-ada-002': { replacement: 'text-embedding-3-small', sunset: '2025-04' },
  'claude-instant-1': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-2': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-2.0': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-2.1': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-3-haiku-20240307': { replacement: 'claude-haiku-3-5', sunset: '2025-06' },
  'claude-3-sonnet-20240229': { replacement: 'claude-sonnet-4-5', sunset: '2025-03' },
  'claude-3-opus-20240229': { replacement: 'claude-opus-4-0', sunset: '2025-09' },
  'gemini-pro': { replacement: 'gemini-2.0-flash', sunset: '2025-02' },
  'gemini-1.0-pro': { replacement: 'gemini-2.0-flash', sunset: '2025-02' },
  'gemini-1.5-pro': { replacement: 'gemini-2.5-pro', sunset: '2025-09' },
  'gemini-1.5-flash': { replacement: 'gemini-2.0-flash', sunset: '2025-09' },
  'text-bison': { replacement: 'gemini-2.0-flash', sunset: '2024-04' },
  'chat-bison': { replacement: 'gemini-2.0-flash', sunset: '2024-04' },
  'command-light': { replacement: 'command-r', sunset: '2025-03' },
  'command-nightly': { replacement: 'command-r-plus', sunset: '2025-03' },
};

const SCAN_EXTS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.php',
  '.yaml', '.yml', '.json', '.toml', '.env', '.env.example', '.env.local', '.cfg', '.ini', '.conf'];
const SELF_IGNORE = ['models.ts', 'models.js', 'model-graveyard', 'model-registry', 'sunset'];
const CONTEXT_REQUIRED = new Set(['command', 'command-light', 'command-nightly']);

function hasModelContext(content: string, model: string): boolean {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contextPatterns = [
    new RegExp(`['"\`]${escaped}['"\`]`),
    new RegExp(`model[_\\s]*[:=].*${escaped}`, 'i'),
    new RegExp(`engine[_\\s]*[:=].*${escaped}`, 'i'),
    new RegExp(`${escaped}.*(?:api|llm|chat|completion)`, 'i'),
  ];
  return contextPatterns.some(p => p.test(content));
}

function builtinModels(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);
  const found = new Map<string, string[]>();

  for (const f of files) {
    if (!SCAN_EXTS.some(ext => f.endsWith(ext))) continue;
    if (SELF_IGNORE.some(s => f.toLowerCase().includes(s))) continue;
    const content = readFile(join(cwd, f));
    if (!content) continue;

    for (const [model, info] of Object.entries(SUNSET_MODELS)) {
      if (!content.includes(model)) continue;
      if (CONTEXT_REQUIRED.has(model) && !hasModelContext(content, model)) continue;
      const existing = found.get(model) || [];
      existing.push(f);
      found.set(model, existing);
    }
  }

  for (const [model, files] of found) {
    const info = SUNSET_MODELS[model];
    const fileList = files.length <= 2 ? files.join(', ') : `${files[0]} +${files.length - 1} more`;
    issues.push({
      severity: 'error',
      message: `deprecated model "${model}" in ${fileList} — use "${info.replacement}"${info.sunset ? ` (sunset ${info.sunset})` : ''}`,
      file: files[0],
      fixable: true,
      fixHint: `replace "${model}" with "${info.replacement}"`,
    });
  }

  const score = Math.max(0, 100 - issues.length * 20);

  return {
    name: 'models',
    score: Math.min(100, score),
    maxScore: 100,
    issues,
    summary: issues.length === 0 ? 'all model references current' : `${issues.length} deprecated model${issues.length > 1 ? 's' : ''} found`,
  };
}

export async function checkModels(cwd: string, ignore: string[]): Promise<CheckResult> {
  const rich = await tryModelGraveyard(cwd);
  if (rich) return rich;
  return builtinModels(cwd, ignore);
}
