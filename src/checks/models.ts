import { join } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { readFile, walkFiles } from '../util.js';

// Model sunset/deprecation registry — kept inline for zero deps
const SUNSET_MODELS: Record<string, { replacement: string; sunset?: string }> = {
  // OpenAI
  'gpt-3.5-turbo': { replacement: 'gpt-4o-mini', sunset: '2025-06' },
  'gpt-4-turbo': { replacement: 'gpt-4o', sunset: '2025-04' },
  'gpt-4-turbo-preview': { replacement: 'gpt-4o', sunset: '2025-04' },
  'gpt-4-0314': { replacement: 'gpt-4o', sunset: '2024-06' },
  'gpt-4-0613': { replacement: 'gpt-4o', sunset: '2025-06' },
  'gpt-4-32k': { replacement: 'gpt-4o', sunset: '2025-06' },
  'text-davinci-003': { replacement: 'gpt-4o-mini', sunset: '2024-01' },
  'code-davinci-002': { replacement: 'gpt-4o', sunset: '2024-01' },
  'text-embedding-ada-002': { replacement: 'text-embedding-3-small', sunset: '2025-04' },

  // Anthropic
  'claude-instant-1': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-2': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-2.0': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-2.1': { replacement: 'claude-sonnet-4-5', sunset: '2024-08' },
  'claude-3-haiku-20240307': { replacement: 'claude-haiku-3-5', sunset: '2025-06' },
  'claude-3-sonnet-20240229': { replacement: 'claude-sonnet-4-5', sunset: '2025-03' },
  'claude-3-opus-20240229': { replacement: 'claude-opus-4-0', sunset: '2025-09' },

  // Google
  'gemini-pro': { replacement: 'gemini-2.0-flash', sunset: '2025-02' },
  'gemini-1.0-pro': { replacement: 'gemini-2.0-flash', sunset: '2025-02' },
  'gemini-1.5-pro': { replacement: 'gemini-2.5-pro', sunset: '2025-09' },
  'gemini-1.5-flash': { replacement: 'gemini-2.0-flash', sunset: '2025-09' },
  'text-bison': { replacement: 'gemini-2.0-flash', sunset: '2024-04' },
  'chat-bison': { replacement: 'gemini-2.0-flash', sunset: '2024-04' },

  // Cohere
  'command': { replacement: 'command-r-plus', sunset: '2025-03' },
  'command-light': { replacement: 'command-r', sunset: '2025-03' },
  'command-nightly': { replacement: 'command-r-plus', sunset: '2025-03' },
};

const SCAN_EXTS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.php',
  '.yaml', '.yml', '.json', '.toml', '.env', '.env.example', '.env.local', '.cfg', '.ini', '.conf'];

// Files that contain model registries should not trigger false positives
const SELF_IGNORE = ['models.ts', 'models.js', 'model-graveyard', 'model-registry', 'sunset'];

// Short model names that need context to avoid false positives (e.g. npm "command" field)
const CONTEXT_REQUIRED = new Set(['command', 'command-light', 'command-nightly']);

function hasModelContext(content: string, model: string): boolean {
  // Require the model name to appear in a string-like context: quotes, assignment, or near "model"/"engine"
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const contextPatterns = [
    new RegExp(`['"\`]${escaped}['"\`]`),                    // quoted
    new RegExp(`model[_\\s]*[:=].*${escaped}`, 'i'),         // model assignment
    new RegExp(`engine[_\\s]*[:=].*${escaped}`, 'i'),        // engine assignment
    new RegExp(`${escaped}.*(?:api|llm|chat|completion)`, 'i'), // near API terms
  ];
  return contextPatterns.some(p => p.test(content));
}

export function checkModels(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);
  const found = new Map<string, string[]>();

  for (const f of files) {
    if (!SCAN_EXTS.some(ext => f.endsWith(ext))) continue;
    // Skip files that are model registries themselves
    if (SELF_IGNORE.some(s => f.toLowerCase().includes(s))) continue;
    const content = readFile(join(cwd, f));
    if (!content) continue;

    for (const [model, info] of Object.entries(SUNSET_MODELS)) {
      if (!content.includes(model)) continue;
      // For short/ambiguous names, require contextual evidence
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

  const score = Math.max(0, 10 - issues.length * 2);

  return {
    name: 'models',
    score: Math.min(10, score),
    maxScore: 10,
    issues,
    summary: issues.length === 0 ? 'all model references current' : `${issues.length} deprecated model${issues.length > 1 ? 's' : ''} found`,
  };
}
