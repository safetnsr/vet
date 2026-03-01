import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ANSI colors — zero deps
export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export function git(cmd: string, cwd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

export function gitExec(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

export function isGitRepo(cwd: string): boolean {
  return git('rev-parse --is-inside-work-tree', cwd) === 'true';
}

export function readFile(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function walkFiles(dir: string, ignore: string[] = []): string[] {
  const results: string[] = [];
  const defaultIgnore = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__', '.venv', 'venv'];
  const allIgnore = [...defaultIgnore, ...ignore];

  function walk(d: string) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (allIgnore.includes(entry)) continue;
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else results.push(relative(dir, full));
      } catch { /* skip */ }
    }
  }
  walk(dir);
  return results;
}

export function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some(p => {
    if (p.endsWith('/')) return file.startsWith(p) || file.includes('/' + p);
    if (p.startsWith('*.')) return file.endsWith(p.slice(1));
    return file === p || file.includes('/' + p);
  });
}
