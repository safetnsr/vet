import { join } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { fileExists, readFile, walkFiles } from '../util.js';

// Codebase AI-readiness: structure, complexity, documentation
export function checkReady(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);

  // 1. README exists — critical for AI context
  const hasReadme = files.some(f => /^readme\.(md|txt|rst)$/i.test(f));
  if (!hasReadme) {
    issues.push({ severity: 'error', message: 'no README — AI agents have no project context', fixable: true, fixHint: 'create a README.md' });
  }

  // 2. Project manifest
  const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json'];
  const hasManifest = manifests.some(m => files.includes(m));
  if (!hasManifest) {
    issues.push({ severity: 'error', message: 'no package manifest — agents can\'t resolve dependencies', fixable: false });
  }

  // 3. Test coverage
  const codeExts = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.php', '.cs', '.swift', '.kt'];
  const testFiles = files.filter(f => /\.(test|spec)\.(ts|js|tsx|jsx|py)$/.test(f) || f.includes('__tests__/') || f.startsWith('tests/') || f.startsWith('test/'));
  const codeFiles = files.filter(f => codeExts.some(ext => f.endsWith(ext)));
  if (codeFiles.length > 5 && testFiles.length === 0) {
    issues.push({ severity: 'error', message: 'no tests — AI agents produce better code when tests exist to validate against', fixable: false });
  }

  // 4. Overly large files (>500 lines)
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

  // 5. .env without .env.example
  const hasEnv = files.some(f => f === '.env' || f === '.env.local');
  const hasEnvExample = files.some(f => f === '.env.example' || f === '.env.template');
  if (hasEnv && !hasEnvExample) {
    issues.push({ severity: 'warning', message: '.env exists but no .env.example — AI agents can\'t see env structure', fixable: false });
  }

  // 6. No types in JS-heavy project
  const tsFiles = files.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
  const jsFiles = files.filter(f => f.endsWith('.js') || f.endsWith('.jsx'));
  if (jsFiles.length > 10 && tsFiles.length === 0 && files.includes('package.json')) {
    issues.push({ severity: 'info', message: `${jsFiles.length} JS files, no TypeScript — typed code gives agents better context`, fixable: false });
  }

  // Recalibrated scoring: errors = -3, warnings = -1.5, info = -0.3
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const infos = issues.filter(i => i.severity === 'info').length;
  const score = Math.max(0, Math.min(10, 10 - errors * 3 - warnings * 1.5 - infos * 0.3));

  return {
    name: 'ready',
    score: Math.round(score * 10) / 10,
    maxScore: 10,
    issues,
    summary: issues.length === 0 ? 'codebase is well-structured for AI' : `${issues.length} readiness issues`,
  };
}
