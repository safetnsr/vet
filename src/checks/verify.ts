import { join, resolve, basename, dirname, extname } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { CheckResult, Issue } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

// ── Config/meta file exclusion for thin-file checks ──────────────────────────

const CONFIG_DOTFILES = new Set([
  '.gitignore', '.gitattributes', '.nvmrc', '.node-version', '.editorconfig',
  '.prettierrc', '.eslintignore', '.npmrc', '.npmignore',
]);

const CONFIG_EXTENSIONS = new Set([
  '.yml', '.yaml', '.json', '.toml', '.cfg', '.ini', '.lock', '.svg', '.xml',
]);

const CONFIG_DIRS = ['.github/', '.husky/', '.vscode/', '.idea/'];

const META_FILES = new Set([
  'FUNDING.yaml', 'CODEOWNERS', 'LICENSE',
  'py.typed', 'MANIFEST.in', 'CITATION.cff',
]);

const META_EXTENSIONS = new Set([
  '.cff', '.mdc', '.txt', '.html', '.md', '.rst', '.csv',
  '.css', '.scss', '.less', '.map', '.wasm',
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
  '.sql', '.graphql', '.gql', '.proto',
]);

/** Source code extensions that should be checked for thin files */
const SOURCE_CODE_EXTS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.mts', '.mjs', '.cts', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.swift', '.kt',
]);

function isConfigOrMetaFile(filePath: string): boolean {
  const base = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const normalized = filePath.replace(/\\/g, '/');

  // All .d.ts declaration files
  if (filePath.endsWith('.d.ts')) return true;

  // *.config.* pattern (vite.config.ts, postcss.config.js, tailwind.config.ts, etc.)
  if (/\.config\.[a-z]+$/i.test(base)) return true;

  // *.rc.* or dotfile rc pattern (.eslintrc.js, .prettierrc.cjs, etc.)
  if (/\.rc\.[a-z]+$/i.test(base) || /^\.[a-z]+rc$/i.test(base) || /^\.[a-z]+rc\.[a-z]+$/i.test(base)) return true;

  // tsconfig variants (tsconfig.json, tsconfig.build.json, etc.)
  if (/^tsconfig(\..+)?\.json$/i.test(base)) return true;

  // Dotfiles
  if (CONFIG_DOTFILES.has(base)) return true;

  // Config extensions
  if (CONFIG_EXTENSIONS.has(ext)) return true;

  // Meta/non-source extensions
  if (META_EXTENSIONS.has(ext)) return true;

  // Config directories
  if (CONFIG_DIRS.some(d => normalized.includes(d) || normalized.startsWith(d))) return true;

  // Meta files
  if (META_FILES.has(base)) return true;
  if (base.startsWith('CHANGELOG')) return true;

  // Any file that is NOT source code should not be flagged for thin content
  if (!SOURCE_CODE_EXTS.has(ext)) return true;

  return false;
}

// ── Code file extensions for test detection ──────────────────────────────────

const CODE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|js|tsx|jsx)$/i;

function isTestFile(filePath: string): boolean {
  const base = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // Only code files can be test files
  if (!CODE_EXTENSIONS.has(ext)) return false;

  if (TEST_FILE_PATTERN.test(base)) return true;
  const normalized = filePath.replace(/\\/g, '/');
  // Match __tests__/ anywhere in path (including at root)
  if (normalized.includes('__tests__/') || normalized.includes('/__tests__')) return true;
  if (normalized.includes('/test/') || normalized.startsWith('test/')) return true;
  if (normalized.includes('/tests/') || normalized.startsWith('tests/')) return true;
  return false;
}

function hasAssertions(content: string): boolean {
  return /\b(assert|expect\s*\(|it\s*\(|test\s*\(|describe\s*\(|should\.|toBe\(|toEqual\(|assertEqual|assertStrictEqual)\b/i.test(content);
}

function countLines(content: string): number {
  return content.split('\n').filter(l => l.trim().length > 0).length;
}

/** Extract file names mentioned in commit messages as claims */
function extractClaimsFromMessages(messages: string[]): string[] {
  const claims: string[] = [];
  // All patterns require a file extension (dot in name) to avoid false positives
  const patterns = [
    /\b(?:creat\w*|add\w*|implement\w*|wrot\w*|built|generat\w*|scaffold\w*)\s+([\w./\\-]+\.[a-z]{1,5})/gi,
    /\b(?:fix\w*|resolv\w*|updat\w*|modify|modified)\s+([\w./\\-]+\.[a-z]{1,5})/gi,
    /\badd\w*\s+tests?\s+(?:for\s+)?([\w./\\-]+\.[a-z]{1,5})/gi,
  ];
  for (const msg of messages) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(msg)) !== null) {
        const candidate = m[1].replace(/[,.:;)]+$/, '');
        if (candidate && candidate.length > 2 && !candidate.startsWith('-')) {
          claims.push(candidate);
        }
      }
    }
  }
  return [...new Set(claims)];
}

/** Get files changed in recent agent session (git diff against since or HEAD~1) */
function getChangedFiles(cwd: string, since?: string): string[] {
  let raw = '';
  if (since) {
    raw = safeExec(`git diff ${since} --name-only`, cwd);
  } else {
    // Try HEAD~1 first
    raw = safeExec(`git diff HEAD~1 --name-only`, cwd);
    if (!raw.trim()) {
      // Fall back to last commit's added/modified files
      raw = safeExec(`git show --name-only --format="" HEAD`, cwd);
    }
  }
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('diff') && !l.startsWith('index'));
}

/** Get recent git log messages */
function getRecentMessages(cwd: string, since?: string): string[] {
  let raw = '';
  if (since) {
    raw = safeExec(`git log ${since}..HEAD --oneline`, cwd);
  } else {
    raw = safeExec(`git log -10 --oneline`, cwd);
  }
  return raw.split('\n').map(l => l.replace(/^[a-f0-9]+\s+/, '').trim()).filter(l => l.length > 0);
}

// ── Python project detection ─────────────────────────────────────────────────

function isPythonProject(cwd: string): boolean {
  const markers = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];
  return markers.some(m => existsSync(join(cwd, m)));
}

/** Directories where small files are expected (examples, demos, docs) */
const SMALL_FILE_DIRS = ['examples/', 'example/', 'demos/', 'demo/', 'docs/'];

/** Next.js app router files that are designed to be small wrappers */
const NEXTJS_APP_FILES = new Set([
  'page.tsx', 'page.jsx', 'page.ts', 'page.js',
  'layout.tsx', 'layout.jsx',
  'loading.tsx', 'loading.jsx',
  'not-found.tsx', 'not-found.jsx',
  'error.tsx', 'error.jsx',
  'template.tsx', 'template.jsx',
]);

function isNextjsAppFile(filePath: string): boolean {
  return NEXTJS_APP_FILES.has(basename(filePath));
}

/** Config files should never be flagged as test files */
function isConfigFile(filePath: string): boolean {
  const base = basename(filePath);
  return /\.config\.[a-z]+$/i.test(base);
}

/** Python pattern directories where small files are expected */
const PYTHON_PATTERN_DIRS = ['profiles/', 'providers/', 'configs/', 'config/', 'tests/', 'test/'];

/** Python pattern file names that are expected to be small */
const PYTHON_PATTERN_NAMES = new Set(['version.py', '__version__.py', 'conftest.py']);

function isPythonBoilerplate(filePath: string): boolean {
  const base = basename(filePath);
  const normalized = filePath.replace(/\\/g, '/');
  if (base === '__init__.py') return true;
  if (base === '__main__.py') return true;
  if (base === 'py.typed') return true;
  if (filePath.endsWith('.pyi')) return true;
  if (normalized.includes('__pycache__/')) return true;
  // Pattern-based small Python files
  if (PYTHON_PATTERN_NAMES.has(base)) return true;
  if (base.endsWith('_utils.py')) return true;
  // Test files in test directories (test_*.py, *_test.py)
  if (/^test_.*\.py$/.test(base) || /^.*_test\.py$/.test(base)) {
    if (PYTHON_PATTERN_DIRS.some(d => normalized.includes(d))) return true;
  }
  // Files in pattern directories (profiles/, providers/, configs/, config/)
  if (base.endsWith('.py') && PYTHON_PATTERN_DIRS.some(d => normalized.includes(d))) return true;
  return false;
}

function isInSmallFileDir(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SMALL_FILE_DIRS.some(d => normalized.includes(d) || normalized.startsWith(d));
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkVerify(cwd: string, since?: string): CheckResult {
  const issues: Issue[] = [];
  let deductions = 0;
  const python = isPythonProject(cwd);

  // Check if git repo
  const isGit = safeExec('git rev-parse --is-inside-work-tree', cwd).trim();
  if (isGit !== 'true') {
    return {
      name: 'verify',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'not a git repository — skipped',
    };
  }

  // Check if any commits exist
  const hasCommits = safeExec('git rev-parse HEAD', cwd).trim();
  if (!hasCommits) {
    return {
      name: 'verify',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no commits found — skipped',
    };
  }

  // Get changed files from git diff
  const changedFiles = getChangedFiles(cwd, since);

  // Get commit messages for claim extraction
  const messages = getRecentMessages(cwd, since);

  // Extract explicit claims from commit messages
  const explicitClaims = extractClaimsFromMessages(messages);

  // Build unified file list to verify: changed files + explicitly claimed files
  const toVerify = new Set<string>();
  for (const f of changedFiles) toVerify.add(f);
  for (const f of explicitClaims) toVerify.add(f);

  if (toVerify.size === 0) {
    return {
      name: 'verify',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no agent claims found in recent git history',
    };
  }

  let verified = 0;
  let failed = 0;

  for (const relPath of toVerify) {
    const absPath = join(cwd, relPath);

    // 1. File must exist
    if (!existsSync(absPath)) {
      // Only flag files that were explicitly in claims from messages (not just diff-referenced)
      // Changed files that don't exist could be deletions — only flag if explicitly claimed
      if (explicitClaims.includes(relPath)) {
        issues.push({
          severity: 'error',
          message: `Claimed file missing: ${relPath}`,
          file: relPath,
          fixable: false,
          fixHint: 'Agent claimed to create this file but it does not exist',
        });
        deductions += 15;
        failed++;
      }
      continue;
    }

    let content = '';
    try {
      const stat = statSync(absPath);
      if (!stat.isFile()) {
        verified++;
        continue;
      }
      content = readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lineCount = countLines(content);

    // 2. File must have meaningful content (>10 non-empty lines)
    // Skip thin file check for Python boilerplate files (always, regardless of project type)
    if (isPythonBoilerplate(relPath)) {
      verified++;
      continue;
    }
    // Skip thin file check for files in examples/docs directories
    if (isInSmallFileDir(relPath)) {
      verified++;
      continue;
    }
    // Skip thin file check for config/meta files (they're supposed to be small)
    if (isConfigOrMetaFile(relPath)) {
      verified++;
      continue;
    }
    // Skip thin file check for Next.js app router files (designed as small wrappers)
    if (isNextjsAppFile(relPath)) {
      verified++;
      continue;
    }
    // Skip barrel index files (index.ts/js/tsx/jsx under 15 lines)
    const indexNames = new Set(['index.ts', 'index.js', 'index.tsx', 'index.jsx']);
    if (indexNames.has(basename(relPath)) && lineCount < 15) {
      verified++;
      continue;
    }

    if (lineCount < 10 && lineCount > 0) {
      issues.push({
        severity: 'warning',
        message: `Thin file: ${relPath} (${lineCount} non-empty lines)`,
        file: relPath,
        fixable: false,
        fixHint: 'Agent claimed to create/modify this file but it has minimal content',
      });
      deductions += 8;
      failed++;
      continue;
    }

    if (lineCount === 0) {
      issues.push({
        severity: 'error',
        message: `Empty file: ${relPath}`,
        file: relPath,
        fixable: false,
        fixHint: 'Agent claimed to create this file but it is empty',
      });
      deductions += 15;
      failed++;
      continue;
    }

    // 3. Test files must have actual assertions (but not config files)
    if (isTestFile(relPath) && !isConfigFile(relPath)) {
      if (!hasAssertions(content)) {
        issues.push({
          severity: 'error',
          message: `Test file has no assertions: ${relPath}`,
          file: relPath,
          fixable: false,
          fixHint: 'Test file exists but contains no expect(), assert(), or test() calls',
        });
        deductions += 12;
        failed++;
        continue;
      }
    }

    verified++;
  }

  const finalScore = Math.max(0, 100 - deductions);

  const baseSummary = failed === 0
    ? `${verified} agent claim${verified !== 1 ? 's' : ''} verified clean`
    : `${failed} claim${failed !== 1 ? 's' : ''} failed verification (${verified} passed)`;
  const summary = python ? `${baseSummary} (python project detected — some checks have reduced scope)` : baseSummary;

  return {
    name: 'verify',
    score: finalScore,
    maxScore: 100,
    issues,
    summary,
  };
}
