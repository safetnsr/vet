import { join } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { fileExists, readFile, walkFiles } from '../util.js';

// Try to use @safetnsr/ai-ready if installed (richer per-file analysis)
async function tryAiReady(cwd: string): Promise<CheckResult | null> {
  try {
    const mod = await import(/* webpackIgnore: true */ '@safetnsr/ai-ready' as string);
    if (typeof mod.main !== 'function') return null;
    const result = mod.main(['--json', cwd]);
    if (!result || result.exitCode !== 0) return null;

    const data = JSON.parse(result.output);
    const issues: Issue[] = [];

    // Convert ai-ready's per-file results to vet issues
    if (data.files) {
      const lowScoreFiles = data.files.filter((f: any) => f.score < 5);
      for (const f of lowScoreFiles.slice(0, 5)) {
        issues.push({
          severity: 'warning',
          message: `${f.file}: readiness ${f.score}/10 — ${f.reasons?.join(', ') || 'low score'}`,
          file: f.file,
          fixable: false,
        });
      }
      if (lowScoreFiles.length > 5) {
        issues.push({ severity: 'info', message: `...and ${lowScoreFiles.length - 5} more low-readiness files`, fixable: false });
      }
    }

    // Map ai-ready score to vet format (scale to 0-100)
    const score = typeof data.score === 'number' ? data.score : 50;
    return {
      name: 'ready',
      score: Math.round(Math.min(100, score <= 10 ? score * 10 : score)),
      maxScore: 100,
      issues,
      summary: `${data.files?.length || 0} files analyzed (via ai-ready) — ${issues.length} issues`,
    };
  } catch {
    return null;
  }
}

// Built-in fallback: simpler project-level checks
function builtinReady(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);

  const hasReadme = files.some(f => /^readme\.(md|txt|rst)$/i.test(f));
  if (!hasReadme) {
    issues.push({ severity: 'error', message: 'no README — AI agents have no project context', fixable: true, fixHint: 'create a README.md' });
  }

  // Detect Python project (root or subdirs)
  const pythonMarkers = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];
  const hasPythonRoot = pythonMarkers.some(m => files.includes(m));
  const hasPythonSubdir = files.some(f => pythonMarkers.some(m => f.endsWith('/' + m) || f.endsWith('\\' + m)));
  const isPython = hasPythonRoot || hasPythonSubdir;

  // Detect monorepo (multiple manifests in subdirs)
  const subPyprojects = files.filter(f => f !== 'pyproject.toml' && f.endsWith('pyproject.toml'));
  const subPackageJsons = files.filter(f => f !== 'package.json' && f.endsWith('package.json'));
  const isMonorepo = subPyprojects.length > 0 || subPackageJsons.length > 1;

  const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];
  const hasManifest = manifests.some(m => files.includes(m));
  // For Python projects, any pyproject.toml in subdirs counts as a manifest
  const hasManifestAnywhere = hasManifest || isPython;
  if (!hasManifestAnywhere) {
    issues.push({ severity: 'error', message: 'no package manifest — agents can\'t resolve dependencies', fixable: false });
  }

  const codeExts = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.php', '.cs', '.swift', '.kt'];
  // Broader test detection: includes Python test patterns and nested test directories
  const testFiles = files.filter(f => {
    if (/\.(test|spec)\.(ts|js|tsx|jsx|py)$/.test(f)) return true;
    if (f.includes('__tests__/')) return true;
    if (f.startsWith('tests/') || f.startsWith('test/')) return true;
    if (f.includes('/tests/') || f.includes('/test/')) return true;
    // Python test file patterns: test_*.py, *_test.py
    if (/(?:^|[/\\])test_[^/\\]+\.py$/.test(f)) return true;
    if (/(?:^|[/\\])[^/\\]+_test\.py$/.test(f)) return true;
    return false;
  });
  const codeFiles = files.filter(f => codeExts.some(ext => f.endsWith(ext)));
  if (codeFiles.length > 5 && testFiles.length === 0) {
    issues.push({ severity: 'error', message: 'no tests — AI agents produce better code when tests exist to validate against', fixable: false });
  }

  let largeFileCount = 0;
  for (const f of files) {
    if (!codeExts.some(ext => f.endsWith(ext))) continue;
    const content = readFile(join(cwd, f));
    if (content && content.split('\n').length > 500) {
      largeFileCount++;
      if (largeFileCount <= 3) {
        issues.push({ severity: 'warning', message: `${f} is ${content.split('\n').length} lines — split for better AI comprehension`, fixable: false });
      }
    }
  }
  if (largeFileCount > 3) {
    issues.push({ severity: 'warning', message: `...and ${largeFileCount - 3} more large files`, fixable: false });
  }

  const hasEnv = files.some(f => f === '.env' || f === '.env.local');
  const hasEnvExample = files.some(f => f === '.env.example' || f === '.env.template');
  if (hasEnv && !hasEnvExample) {
    issues.push({ severity: 'warning', message: '.env exists but no .env.example — AI agents can\'t see env structure', fixable: false });
  }

  const tsFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const jsFiles = files.filter(f => f.endsWith('.js') || f.endsWith('.jsx'));
  if (jsFiles.length > 10 && tsFiles.length === 0 && files.includes('package.json')) {
    issues.push({ severity: 'info', message: `${jsFiles.length} JS files, no TypeScript — typed code gives agents better context`, fixable: false });
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const infos = issues.filter(i => i.severity === 'info').length;
  const score = Math.max(0, Math.min(100, 100 - errors * 30 - warnings * 15 - infos * 3));

  let summary = issues.length === 0 ? 'codebase is well-structured for AI' : `${issues.length} readiness issues`;
  if (isMonorepo) summary += ' (monorepo detected)';

  return {
    name: 'ready',
    score: Math.round(score),
    maxScore: 100,
    issues,
    summary,
  };
}

export async function checkReady(cwd: string, ignore: string[]): Promise<CheckResult> {
  try {
    const rich = await tryAiReady(cwd);
    if (rich) return rich;
    return builtinReady(cwd, ignore);
  } catch {
    return { name: 'ready', score: 100, maxScore: 100, issues: [], summary: 'ready check failed' };
  }
}
