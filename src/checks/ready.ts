import { join } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { fileExists, readFile, walkFiles, matchesAny } from '../util.js';

// Codebase AI-readiness: structure, complexity, documentation
export function checkReady(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);

  // 1. README exists
  const hasReadme = files.some(f => /^readme\.(md|txt|rst)$/i.test(f));
  if (!hasReadme) {
    issues.push({ severity: 'warning', message: 'no README found — AI agents work better with project context', fixable: true, fixHint: 'create a README.md' });
  }

  // 2. Project manifest
  const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];
  const hasManifest = manifests.some(m => files.includes(m));
  if (!hasManifest) {
    issues.push({ severity: 'warning', message: 'no package manifest found — agents need dependency context', fixable: false });
  }

  // 3. Check for overly large files (>500 lines is harder for AI to reason about)
  let largeFileCount = 0;
  const codeExts = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.php', '.cs', '.swift', '.kt'];
  for (const f of files) {
    if (!codeExts.some(ext => f.endsWith(ext))) continue;
    const content = readFile(join(cwd, f));
    if (content) {
      const lines = content.split('\n').length;
      if (lines > 500) {
        largeFileCount++;
        if (largeFileCount <= 3) {
          issues.push({ severity: 'info', message: `${f} is ${lines} lines — consider splitting for better AI comprehension`, fixable: false });
        }
      }
    }
  }
  if (largeFileCount > 3) {
    issues.push({ severity: 'info', message: `...and ${largeFileCount - 3} more large files`, fixable: false });
  }

  // 4. Check for .env.example (helps AI understand required env vars)
  const hasEnv = files.some(f => f === '.env' || f === '.env.local');
  const hasEnvExample = files.some(f => f === '.env.example' || f === '.env.template');
  if (hasEnv && !hasEnvExample) {
    issues.push({ severity: 'warning', message: '.env exists but no .env.example — AI agents can\'t see your env structure', fixable: false });
  }

  // 5. TypeScript/Python type coverage
  const tsFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const jsFiles = files.filter(f => f.endsWith('.js') || f.endsWith('.jsx'));
  if (jsFiles.length > 10 && tsFiles.length === 0 && files.includes('package.json')) {
    issues.push({ severity: 'info', message: `${jsFiles.length} JS files with no TypeScript — typed code gives AI agents better context`, fixable: false });
  }

  // 6. Test coverage indicator
  const testFiles = files.filter(f => /\.(test|spec)\.(ts|js|tsx|jsx|py)$/.test(f) || f.includes('__tests__/') || f.startsWith('tests/') || f.startsWith('test/'));
  const codeFiles = files.filter(f => codeExts.some(ext => f.endsWith(ext)));
  if (codeFiles.length > 5 && testFiles.length === 0) {
    issues.push({ severity: 'warning', message: 'no test files found — AI agents produce better code when tests exist to validate against', fixable: false });
  }

  // Score: start at 10, deduct
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const infos = issues.filter(i => i.severity === 'info').length;
  const score = Math.max(0, Math.min(10, 10 - errors * 2 - warnings * 1 - infos * 0.3));

  return {
    name: 'ready',
    score: Math.round(score * 10) / 10,
    maxScore: 10,
    issues,
    summary: issues.length === 0 ? 'codebase is well-structured for AI' : `${issues.length} suggestions for better AI readiness`,
  };
}
