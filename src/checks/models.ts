import { join, basename } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import type { CheckResult, Issue } from '../types.js';
import { readFile, walkFiles } from '../util.js';

// ── AI framework detection ───────────────────────────────────────────────────

const AI_NAME_KEYWORDS = ['ai', 'llm', 'openai', 'anthropic', 'langchain', 'provider'];
const AI_PKG_KEYWORDS = new Set(['ai', 'llm', 'language-model', 'openai', 'anthropic']);

function isAiFramework(cwd: string): boolean {
  const aiDeps = ['openai', 'anthropic', 'langchain', 'transformers', 'torch', 'tensorflow', 'llama', 'huggingface'];

  // Check package.json
  const pkgRaw = readFile(join(cwd, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const name = (pkg.name || '').toLowerCase();
      if (AI_NAME_KEYWORDS.some(k => name.includes(k))) return true;
      if (Array.isArray(pkg.keywords) && pkg.keywords.some((k: string) => AI_PKG_KEYWORDS.has(k.toLowerCase()))) return true;
      // Check if any AI SDK is in dependencies
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (aiDeps.some(d => allDeps[d])) return true;
    } catch { /* skip */ }
  }

  // Check pyproject.toml / setup.py in root AND subdirectories (up to 2 levels deep for monorepos)
  const pyprojectPaths = [join(cwd, 'pyproject.toml')];
  try {
    const entries = readdirSync(cwd);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const subPath = join(cwd, entry);
      const subPyproject = join(subPath, 'pyproject.toml');
      if (existsSync(subPyproject)) pyprojectPaths.push(subPyproject);
      // Check 2 levels deep for monorepos (e.g., libs/langchain/pyproject.toml)
      try {
        const subEntries = readdirSync(subPath);
        for (const subEntry of subEntries) {
          if (subEntry.startsWith('.') || subEntry === 'node_modules') continue;
          const deepPyproject = join(subPath, subEntry, 'pyproject.toml');
          if (existsSync(deepPyproject)) pyprojectPaths.push(deepPyproject);
        }
      } catch { /* not a directory or unreadable */ }
    }
  } catch { /* skip */ }

  for (const pyprojectPath of pyprojectPaths) {
    const pyproject = readFile(pyprojectPath);
    if (pyproject && aiDeps.some(d => pyproject.includes(d))) return true;
  }

  const setupPy = readFile(join(cwd, 'setup.py'));
  if (setupPy && aiDeps.some(d => setupPy.includes(d))) return true;

  // Check directory name for AI keywords (use word-boundary-like matching with separators)
  const dirName = basename(cwd).toLowerCase();
  const dirParts = dirName.split(/[-_./\\]/);
  const DIR_AI_KEYWORDS = ['ai', 'llm', 'openai', 'anthropic', 'langchain', 'pydantic-ai', 'autogen', 'crewai'];
  if (DIR_AI_KEYWORDS.some(k => dirParts.includes(k) || dirName.includes(k))) return true;

  // Check CLAUDE.md or .claude/settings.json for AI/LLM terms
  const claudeMd = readFile(join(cwd, 'CLAUDE.md'));
  if (claudeMd) {
    const aiTerms = /\b(llm|language model|ai agent|openai|anthropic|embedding|vector|rag|prompt|fine.?tun)/i;
    if (aiTerms.test(claudeMd)) return true;
  }
  const claudeSettings = readFile(join(cwd, '.claude', 'settings.json'));
  if (claudeSettings) {
    const aiTerms = /\b(llm|language model|ai|openai|anthropic|model)/i;
    if (aiTerms.test(claudeSettings)) return true;
  }

  return false;
}

// ── Test/example/docs path detection ─────────────────────────────────────────

const TEST_DOCS_PATTERNS = ['test/', 'tests/', '__tests__/', 'examples/', 'docs/'];

function isTestOrDocsFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  if (TEST_DOCS_PATTERNS.some(p => normalized.includes(p) || normalized.startsWith(p))) return true;
  const base = basename(filePath);
  if (/\.(test|spec)\./i.test(base)) return true;
  if (base.endsWith('.md')) return true;
  return false;
}

// Try to use @safetnsr/model-graveyard if installed (248 models, alias matching, YAML registry)
async function tryModelGraveyard(cwd: string): Promise<CheckResult | null> {
  try {
    const mod = await import(/* webpackIgnore: true */ '@safetnsr/model-graveyard' as string);
    if (typeof mod.scan !== 'function') return null;

    const report = await mod.scan(cwd);
    const issues: Issue[] = [];
    const aiFramework = isAiFramework(cwd);

    // Files that define deprecated model registries should not be flagged
    const SELF_FILES = ['models.ts', 'models.js', 'model-graveyard', 'model-registry', 'sunset', 'fix/models'];
    const GENERATED_PATTERNS = ['.generated.', '.gen.'];

    for (const match of report.matches) {
      if (!match.model) continue;
      // Skip self-referencing files (model definition/fix files)
      if (match.file && SELF_FILES.some(s => match.file.toLowerCase().includes(s))) continue;
      // Skip auto-generated model registries
      if (match.file && GENERATED_PATTERNS.some(p => match.file.includes(p))) continue;
      if (match.model.status === 'deprecated' || match.model.status === 'eol') {
        const inTestDocs = match.file && isTestOrDocsFile(match.file);
        const severity: 'error' | 'info' = (aiFramework || inTestDocs) ? 'info' : 'error';
        issues.push({
          severity,
          message: `${match.model.status} model "${match.raw}" in ${match.file}:${match.line}${match.model.successor ? ` — use "${match.model.successor}"` : ''}`,
          file: match.file,
          line: match.line,
          fixable: !!match.model.successor,
          fixHint: match.model.successor ? `replace "${match.raw}" with "${match.model.successor}"` : undefined,
        });
      }
    }

    const errorCount = issues.filter(i => i.severity === 'error').length;
    const score = aiFramework
      ? Math.max(70, 100 - errorCount * 20)
      : Math.max(0, 100 - errorCount * 20);

    let summary = issues.length === 0
      ? `${report.filesScanned} files scanned (via model-graveyard) — all current`
      : `${issues.length} deprecated model${issues.length > 1 ? 's' : ''} (via model-graveyard)`;
    if (aiFramework) {
      summary += ' — AI framework detected — model references are expected';
    }

    return {
      name: 'models',
      score: Math.min(100, score),
      maxScore: 100,
      issues,
      summary,
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
  const aiFramework = isAiFramework(cwd);

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

  for (const [model, modelFiles] of found) {
    const info = SUNSET_MODELS[model];
    const fileList = modelFiles.length <= 2 ? modelFiles.join(', ') : `${modelFiles[0]} +${modelFiles.length - 1} more`;

    // Determine severity: downgrade for AI frameworks or test/docs files
    const allInTestDocs = modelFiles.every(f => isTestOrDocsFile(f));
    const severity: 'error' | 'info' = (aiFramework || allInTestDocs) ? 'info' : 'error';

    issues.push({
      severity,
      message: `deprecated model "${model}" in ${fileList} — use "${info.replacement}"${info.sunset ? ` (sunset ${info.sunset})` : ''}`,
      file: modelFiles[0],
      fixable: true,
      fixHint: `replace "${model}" with "${info.replacement}"`,
    });
  }

  let score: number;
  if (aiFramework) {
    // AI framework: models exist for compatibility, score 70+ base
    const errorCount = issues.filter(i => i.severity === 'error').length;
    score = Math.max(70, 100 - errorCount * 20);
  } else {
    const errorCount = issues.filter(i => i.severity === 'error').length;
    score = Math.max(0, 100 - errorCount * 20);
  }

  let summary = issues.length === 0
    ? 'all model references current'
    : `${issues.length} deprecated model${issues.length > 1 ? 's' : ''} found`;
  if (aiFramework) {
    summary += ' — AI framework detected — model references are expected';
  }

  return {
    name: 'models',
    score: Math.min(100, score),
    maxScore: 100,
    issues,
    summary,
  };
}

export async function checkModels(cwd: string, ignore: string[]): Promise<CheckResult> {
  try {
    const rich = await tryModelGraveyard(cwd);
    if (rich) return rich;
    return builtinModels(cwd, ignore);
  } catch {
    return { name: 'models', score: 100, maxScore: 100, issues: [], summary: 'models check failed' };
  }
}
