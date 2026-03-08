import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { walkFiles, readFile } from '../util.js';
import { cachedRead } from '../file-cache.js';
import type { CheckResult, Issue } from '../types.js';

// ── Top packages list (~150 popular npm packages) ────────────────────────────

const TOP_PACKAGES = [
  'react', 'react-dom', 'next', 'vue', 'angular', 'express', 'koa', 'fastify', 'hono',
  'axios', 'node-fetch', 'chalk', 'commander', 'yargs', 'inquirer', 'lodash', 'underscore',
  'ramda', 'moment', 'dayjs', 'date-fns', 'uuid', 'nanoid', 'dotenv', 'cors', 'helmet',
  'morgan', 'winston', 'pino', 'debug', 'zod', 'joi', 'yup', 'ajv', 'prettier', 'eslint',
  'typescript', 'webpack', 'vite', 'rollup', 'esbuild', 'swc', 'babel', 'jest', 'vitest',
  'mocha', 'chai', 'sinon', 'supertest', 'playwright', 'puppeteer', 'cypress', 'mongoose',
  'prisma', 'drizzle-orm', 'knex', 'sequelize', 'pg', 'mysql2', 'better-sqlite3', 'redis',
  'ioredis', 'bullmq', 'sharp', 'jimp', 'multer', 'formidable', 'nodemailer', 'socket.io',
  'ws', 'mqtt', 'graphql', 'apollo-server', 'trpc', 'stripe', 'aws-sdk', 'firebase',
  'supabase', 'openai', 'langchain', 'oclif', 'glob', 'minimatch', 'micromatch', 'semver',
  'minimist', 'cross-env', 'concurrently', 'tsx', 'ts-node', 'rimraf', 'mkdirp', 'fs-extra',
  'chokidar', 'ora', 'listr2', 'boxen', 'figlet', 'gradient-string', 'conf', 'cosmiconfig',
  'execa', 'got', 'ky', 'undici', 'cheerio', 'jsdom', 'marked', 'gray-matter', 'unified',
  'rehype', 'remark', 'mdast', 'hast', 'three', 'd3', 'chart.js', 'tailwindcss', 'postcss',
  'sass', 'less', 'styled-components', 'emotion',
];

// ── Node.js builtins ─────────────────────────────────────────────────────────

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib', 'test',
  // also with node: prefix variants handled separately
  'fs/promises', 'stream/promises', 'timers/promises', 'dns/promises',
  'stream/web', 'stream/consumers', 'readline/promises', 'util/types',
]);

// ── Levenshtein distance ─────────────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
  }
  for (let j = 1; j <= n; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

// ── Import extraction ────────────────────────────────────────────────────────

export function extractImports(source: string): string[] {
  const imports = new Set<string>();

  // static import: import X from <specifier>
  const importFrom = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importFrom.exec(source)) !== null) {
    imports.add(match[1]);
  }

  // CommonJS require
  const requirePat = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requirePat.exec(source)) !== null) {
    imports.add(match[1]);
  }

  // dynamic import()
  const dynamicImport = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImport.exec(source)) !== null) {
    imports.add(match[1]);
  }

  // Filter out template literal fragments (e.g. "${top}" from fixHint strings)
  return [...imports].filter(s => !s.includes('$'));
}

// ── Package name extraction ──────────────────────────────────────────────────

export function extractPackageName(specifier: string): string | null {
  // Skip relative imports
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;

  // Skip node: builtins
  if (specifier.startsWith('node:')) return null;

  // Path aliases: @/ is always a path alias (no npm package starts with @/)
  if (specifier.startsWith('@/')) return null;

  // Scoped packages: @scope/name or @scope/name/sub
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    if (parts.length < 2) return null; // bare @scope with no / is not a valid package
    return `${parts[0]}/${parts[1]}`;
  }

  // Regular package: name or name/sub
  return specifier.split('/')[0];
}

// ── Builtin check ────────────────────────────────────────────────────────────

export function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  const name = specifier.split('/')[0];
  if (NODE_BUILTINS.has(name)) return true;
  // Also check full specifier for subpath builtins
  if (NODE_BUILTINS.has(specifier)) return true;
  return false;
}

// ── Registry check with concurrency limit ────────────────────────────────────

async function checkRegistry(packages: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const queue = [...packages];
  let networkError = false;

  async function checkOne(pkg: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      results.set(pkg, res.status !== 404);
    } catch {
      networkError = true;
      results.set(pkg, true); // assume exists on error
    }
  }

  // Process in batches of 5
  try {
    const concurrency = 5;
    for (let i = 0; i < queue.length; i += concurrency) {
      const batch = queue.slice(i, i + concurrency);
      await Promise.all(batch.map(checkOne));
    }
  } catch {
    networkError = true;
  }

  if (networkError) {
    results.set('__network_error__', true);
  }

  return results;
}

// ── Workspace detection ──────────────────────────────────────────────────────

export function detectWorkspacePackages(cwd: string): Set<string> {
  const names = new Set<string>();

  // Detect workspace globs from package.json, pnpm-workspace.yaml, lerna.json
  const globs: string[] = [];

  try {
    const pkgRaw = readFile(join(cwd, 'package.json'));
    if (pkgRaw) {
      const pkg = JSON.parse(pkgRaw);
      if (Array.isArray(pkg.workspaces)) {
        globs.push(...pkg.workspaces);
      } else if (pkg.workspaces?.packages) {
        globs.push(...pkg.workspaces.packages);
      }
    }
  } catch { /* skip */ }

  try {
    const pnpmWs = readFile(join(cwd, 'pnpm-workspace.yaml'));
    if (pnpmWs) {
      // Simple YAML parse: extract lines like "  - 'packages/*'"
      const matches = pnpmWs.matchAll(/['"]?([^'":\n]+\*[^'":\n]*)['"]?/g);
      for (const m of matches) globs.push(m[1].trim());
    }
  } catch { /* skip */ }

  try {
    const lernaRaw = readFile(join(cwd, 'lerna.json'));
    if (lernaRaw) {
      const lerna = JSON.parse(lernaRaw);
      if (Array.isArray(lerna.packages)) globs.push(...lerna.packages);
    }
  } catch { /* skip */ }

  // Resolve globs to workspace package.json files
  for (const glob of globs) {
    // Handle simple globs like "packages/*"
    const parts = glob.replace(/\/$/, '').split('/');
    const starIdx = parts.indexOf('*');
    if (starIdx === -1) {
      // Exact directory
      try {
        const pkgPath = join(cwd, glob, 'package.json');
        const raw = readFile(pkgPath);
        if (raw) {
          const pkg = JSON.parse(raw);
          if (pkg.name) names.add(pkg.name);
        }
      } catch { /* skip */ }
    } else {
      // Wildcard — list directory at the non-wildcard prefix
      const prefix = parts.slice(0, starIdx).join('/');
      const prefixDir = join(cwd, prefix);
      try {
        if (existsSync(prefixDir) && statSync(prefixDir).isDirectory()) {
          for (const entry of readdirSync(prefixDir)) {
            const entryDir = join(prefixDir, entry);
            try {
              if (!statSync(entryDir).isDirectory()) continue;
              // If there are more parts after *, recurse
              const suffix = parts.slice(starIdx + 1);
              const pkgDir = suffix.length > 0 ? join(entryDir, ...suffix) : entryDir;
              const pkgPath = join(pkgDir, 'package.json');
              const raw = readFile(pkgPath);
              if (raw) {
                const pkg = JSON.parse(raw);
                if (pkg.name) names.add(pkg.name);
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
  }

  return names;
}

// ── Plugin host-provided deps ────────────────────────────────────────────────

export function detectProvidedDeps(cwd: string): Set<string> {
  const provided = new Set<string>();

  try {
    const pkgRaw = readFile(join(cwd, 'package.json'));
    if (!pkgRaw) return provided;
    const pkg = JSON.parse(pkgRaw);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Obsidian plugin
    const hasObsidian = 'obsidian' in (allDeps || {});
    const manifestPath = join(cwd, 'manifest.json');
    let hasManifestId = false;
    try {
      const manifestRaw = readFile(manifestPath);
      if (manifestRaw) {
        const manifest = JSON.parse(manifestRaw);
        if (manifest.id) hasManifestId = true;
      }
    } catch { /* skip */ }
    if (hasObsidian || hasManifestId) {
      provided.add('obsidian');
      provided.add('electron');
      // @codemirror/* is handled by prefix check below
      provided.add('@codemirror/*');
    }

    // VSCode extension
    if (pkg.engines?.vscode) {
      provided.add('vscode');
    }

    // Electron app
    if (allDeps?.electron) {
      provided.add('electron');
    }
  } catch { /* skip */ }

  return provided;
}

function isProvidedPackage(pkg: string, provided: Set<string>): boolean {
  if (provided.has(pkg)) return true;
  // Handle @codemirror/* wildcard
  if (provided.has('@codemirror/*') && pkg.startsWith('@codemirror/')) return true;
  return false;
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkDeps(cwd: string): Promise<CheckResult> {
  try {
  const issues: Issue[] = [];

  // Read package.json
  let declaredDeps: Record<string, string> = {};
  let hasPkgJson = false;
  try {
    const pkgRaw = readFile(join(cwd, 'package.json'));
    if (pkgRaw) {
      const pkg = JSON.parse(pkgRaw);
      hasPkgJson = true;
      declaredDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    }
  } catch { /* skip */ }

  if (!hasPkgJson) {
    return {
      name: 'deps',
      score: 100,
      maxScore: 100,
      issues: [],
      summary: 'no package.json found',
    };
  }

  const declaredNames = Object.keys(declaredDeps);

  // ── 1. Registry check (nonexistent packages) ──────────────────────────────
  const registryResults = await checkRegistry(declaredNames);

  if (registryResults.get('__network_error__')) {
    issues.push({
      severity: 'info',
      message: 'could not reach npm registry — skipping existence checks',
      fixable: false,
    });
  }

  for (const pkg of declaredNames) {
    if (registryResults.get(pkg) === false) {
      issues.push({
        severity: 'error',
        message: `phantom dependency: "${pkg}" does not exist on npm`,
        file: 'package.json',
        fixable: true,
        fixHint: 'remove from package.json',
      });
    }
  }

  // ── 2. Typosquat detection ─────────────────────────────────────────────────
  const topSet = new Set(TOP_PACKAGES);
  // Known-legitimate short packages that happen to be close to popular ones
  const TYPOSQUAT_WHITELIST = new Set([
    'ai', 'clsx', 'ws', 'os', 'ms', 'pg', 'ip', 'bn', 'qs', 'co', 'is',
  ]);
  for (const pkg of declaredNames) {
    if (topSet.has(pkg)) continue; // it IS the popular package
    if (pkg.length <= 3) continue; // too short, too many false matches
    if (TYPOSQUAT_WHITELIST.has(pkg)) continue;
    for (const top of TOP_PACKAGES) {
      const dist = levenshtein(pkg, top);
      if (dist >= 1 && dist <= 2) {
        // If the package exists on the registry, it's likely legitimate — downgrade to info
        const existsOnRegistry = registryResults.get(pkg) === true;
        issues.push({
          severity: existsOnRegistry ? 'info' : 'error',
          message: `possible typosquat: "${pkg}" is ${dist} edit${dist > 1 ? 's' : ''} from "${top}"${existsOnRegistry ? ' (exists on npm)' : ''}`,
          file: 'package.json',
          fixable: true,
          fixHint: `did you mean "${top}"?`,
        });
        break; // one match is enough
      }
    }
  }

  // ── 3 & 4. Dead deps + phantom imports ─────────────────────────────────────
  const sourceExts = new Set(['.ts', '.js', '.tsx', '.jsx', '.mts', '.mjs', '.cts', '.cjs']);
  const allFiles = walkFiles(cwd);
  const isTestFile = (f: string) => /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__') || /^test[/\\]/.test(f);
  const sourceFiles = allFiles.filter(f => {
    const ext = f.substring(f.lastIndexOf('.'));
    // Skip test files — they contain import strings as test fixtures, not real imports
    return sourceExts.has(ext) && !isTestFile(f);
  });

  const importedPackages = new Set<string>();
  for (const file of sourceFiles) {
    try {
      const content = cachedRead(join(cwd, file));
      const rawImports = extractImports(content);
      for (const imp of rawImports) {
        if (isBuiltin(imp)) continue;
        const pkg = extractPackageName(imp);
        if (pkg) importedPackages.add(pkg);
      }
    } catch { /* skip unreadable files */ }
  }

  // Dead deps: declared but never imported
  const declaredSet = new Set(declaredNames);
  for (const pkg of declaredNames) {
    if (!importedPackages.has(pkg)) {
      // Check if it's a CLI tool / plugin / type package (common false positives)
      // Still flag it, but as info
      issues.push({
        severity: 'info',
        message: `unused dependency: "${pkg}" is declared but never imported`,
        file: 'package.json',
        fixable: true,
        fixHint: 'remove from package.json',
      });
    }
  }

  // Detect workspace packages and host-provided deps
  const workspacePackages = detectWorkspacePackages(cwd);
  const providedDeps = detectProvidedDeps(cwd);

  // Phantom imports: imported but not declared
  for (const pkg of importedPackages) {
    if (!declaredSet.has(pkg)) {
      // Skip workspace packages
      if (workspacePackages.has(pkg)) continue;
      // Skip host-provided deps
      if (isProvidedPackage(pkg, providedDeps)) continue;
      issues.push({
        severity: 'warning',
        message: `phantom import: "${pkg}" is imported but not in package.json`,
        fixable: true,
        fixHint: `run: npm install ${pkg}`,
      });
    }
  }

  // ── Scoring ────────────────────────────────────────────────────────────────
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const rawScore = 100 - (errors * 30) - (warnings * 10);
  const finalScore = Math.max(0, Math.min(100, rawScore));

  // ── Summary ────────────────────────────────────────────────────────────────
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
  const infos = issues.filter(i => i.severity === 'info').length;
  if (infos > 0) parts.push(`${infos} info`);

  const summary = parts.length === 0
    ? `${declaredNames.length} dependencies checked, all clean`
    : `${declaredNames.length} dependencies: ${parts.join(', ')}`;

  return {
    name: 'deps',
    score: finalScore,
    maxScore: 100,
    issues,
    summary,
  };
  } catch {
    return { name: 'deps', score: 100, maxScore: 100, issues: [], summary: 'deps check failed' };
  }
}
