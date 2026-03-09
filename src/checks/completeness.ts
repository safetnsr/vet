import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { walkFiles, readFile } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

/**
 * Completeness check — scores repos on presence of good practices.
 * 
 * Unlike other checks (penalty-based), this is BONUS-based:
 * starts at 0 and adds points for good signals.
 * This prevents empty/joke repos from scoring 100.
 */
export async function checkCompleteness(cwd: string, ignore: string[]): Promise<CheckResult> {
  const issues: Issue[] = [];
  let points = 0;
  const maxPoints = 100;

  const files = walkFiles(cwd, ignore);
  const fileNames = files.map(f => f.toLowerCase());

  // ── Source code presence (0-25 points) ──
  const jstsFiles = files.filter(f => /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(f));
  const srcFiles = jstsFiles.filter(f => !/node_modules|\.test\.|\.spec\.|__tests__/.test(f));

  if (srcFiles.length === 0) {
    issues.push({
      file: '',
      message: 'no JS/TS source files found',
      severity: 'warning',
      fixable: false,
    });
    // No source = max 30 points total (can't be a good JS/TS project)
    return {
      name: 'completeness',
      score: 0,
      maxScore: 100,
      issues,
      summary: 'no JS/TS source files',
    };
  }

  if (srcFiles.length >= 3) points += 25;
  else if (srcFiles.length >= 1) points += 15;

  // ── Tests presence (0-20 points) ──
  const testFiles = jstsFiles.filter(f => /\.test\.|\.spec\.|__tests__/.test(f));
  const hasTestDir = fileNames.some(f => f.startsWith('test/') || f.startsWith('tests/') || f.startsWith('__tests__/'));

  if (testFiles.length >= 5) {
    points += 20;
  } else if (testFiles.length >= 1 || hasTestDir) {
    points += 10;
    issues.push({
      file: '',
      message: `only ${testFiles.length} test file(s) found`,
      severity: 'info',
      fixable: false,
    });
  } else {
    issues.push({
      file: '',
      message: 'no test files found',
      severity: 'warning',
      fixable: false,
    });
  }

  // ── Package.json quality (0-15 points) ──
  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFile(pkgPath) ?? '{}');
      let pkgPoints = 0;
      if (pkg.name) pkgPoints += 3;
      if (pkg.description) pkgPoints += 3;
      if (pkg.license) pkgPoints += 3;
      if (pkg.scripts?.test) pkgPoints += 3;
      if (pkg.scripts?.build || pkg.scripts?.compile) pkgPoints += 3;
      points += Math.min(15, pkgPoints);
    } catch { /* skip */ }
  } else {
    issues.push({
      file: 'package.json',
      message: 'no package.json found',
      severity: 'info',
      fixable: false,
    });
  }

  // ── TypeScript (0-10 points) ──
  const hasTsConfig = existsSync(join(cwd, 'tsconfig.json'));
  const tsFiles = files.filter(f => /\.tsx?$/.test(f));
  if (hasTsConfig && tsFiles.length > 0) {
    points += 10;
  } else if (tsFiles.length > 0) {
    points += 5;
  }

  // ── Documentation (0-10 points) ──
  const hasReadme = fileNames.some(f => f === 'readme.md' || f === 'readme');
  const hasChangelog = fileNames.some(f => f.includes('changelog'));
  const hasContributing = fileNames.some(f => f.includes('contributing'));
  if (hasReadme) points += 5;
  if (hasChangelog || hasContributing) points += 5;

  // ── CI/CD (0-10 points) ──
  const hasCI = existsSync(join(cwd, '.github/workflows')) ||
                existsSync(join(cwd, '.gitlab-ci.yml')) ||
                existsSync(join(cwd, '.circleci'));
  if (hasCI) points += 10;

  // ── Git freshness (0-10 points, negative for very stale) ──
  try {
    const lastCommit = execSync('git log -1 --format=%ct', { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    const ageMonths = (Date.now() / 1000 - parseInt(lastCommit)) / (30 * 24 * 3600);
    if (ageMonths < 6) {
      points += 10; // actively maintained
    } else if (ageMonths < 12) {
      points += 5;
    } else if (ageMonths < 24) {
      // no bonus, no penalty
      issues.push({
        file: '',
        message: `last commit ${Math.round(ageMonths)} months ago`,
        severity: 'info',
        fixable: false,
      });
    } else {
      // Stale: actively penalize
      points -= 15;
      issues.push({
        file: '',
        message: `last commit ${Math.round(ageMonths)} months ago — likely abandoned`,
        severity: 'warning',
        fixable: false,
      });
    }
  } catch { /* not a git repo or no commits */ }

  // ── Linting/Formatting (0-10 points) ──
  const hasLint = existsSync(join(cwd, '.eslintrc.json')) ||
                  existsSync(join(cwd, '.eslintrc.js')) ||
                  existsSync(join(cwd, '.eslintrc.cjs')) ||
                  existsSync(join(cwd, 'eslint.config.js')) ||
                  existsSync(join(cwd, 'eslint.config.mjs')) ||
                  existsSync(join(cwd, 'biome.json')) ||
                  existsSync(join(cwd, 'biome.jsonc'));
  const hasPrettier = existsSync(join(cwd, '.prettierrc')) ||
                      existsSync(join(cwd, '.prettierrc.json')) ||
                      existsSync(join(cwd, 'prettier.config.js'));
  if (hasLint) points += 5;
  if (hasPrettier || hasLint) points += 5;

  const score = Math.min(maxPoints, points);

  const parts: string[] = [];
  if (srcFiles.length > 0) parts.push(`${srcFiles.length} source files`);
  if (testFiles.length > 0) parts.push(`${testFiles.length} test files`);
  if (hasTsConfig) parts.push('TypeScript');
  if (hasCI) parts.push('CI');

  return {
    name: 'completeness',
    score,
    maxScore: 100,
    issues,
    summary: parts.length > 0 ? parts.join(', ') : 'minimal project',
  };
}
