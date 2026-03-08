import { readFileSync } from 'node:fs';

// Singleton file cache — read once, share across all checks
const cache = new Map<string, string>();

export function cachedRead(path: string): string {
  if (cache.has(path)) return cache.get(path)!;
  const content = readFileSync(path, 'utf-8');
  cache.set(path, content);
  return content;
}

/** Cached readFile that returns null on error (matches util.readFile signature) */
export function cachedReadFile(path: string): string | null {
  try { return cachedRead(path); } catch { return null; }
}

export function clearCache(): void {
  cache.clear();
}
