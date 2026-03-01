import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, walkFiles, fileExists, c } from '../util.js';

export function fixLinks(cwd: string, ignore: string[]): { fixed: number; messages: string[] } {
  const messages: string[] = [];
  let fixed = 0;
  const files = walkFiles(cwd, ignore);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  // Build file index for finding correct targets
  const fileIndex = new Map<string, string>();
  for (const f of files) {
    const name = f.split('/').pop() || '';
    const nameNoExt = name.replace(/\.[^.]+$/, '');
    fileIndex.set(nameNoExt.toLowerCase(), f);
    fileIndex.set(name.toLowerCase(), f);
  }

  for (const mdFile of mdFiles) {
    const fullPath = join(cwd, mdFile);
    let content = readFile(fullPath);
    if (!content) continue;

    const dir = dirname(mdFile);
    let changed = false;

    // Fix broken relative links by finding the target file
    content = content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text, target) => {
      const cleanTarget = target.split('#')[0].split('?')[0];
      if (!cleanTarget) return match;
      if (cleanTarget.startsWith('http://') || cleanTarget.startsWith('https://') || cleanTarget.startsWith('mailto:')) return match;

      const resolved = join(dir, cleanTarget);
      if (fileExists(join(cwd, resolved))) return match; // link is fine

      // Try to find the target file
      const targetName = cleanTarget.split('/').pop()?.replace(/\.[^.]+$/, '')?.toLowerCase() || '';
      const found = fileIndex.get(targetName);
      if (found) {
        // Calculate relative path from this file to the found file
        const fromDir = dirname(mdFile);
        let newTarget = found;
        if (fromDir !== '.') {
          const fromParts = fromDir.split('/');
          const toParts = found.split('/');
          // Simple relative path
          const ups = fromParts.length;
          newTarget = '../'.repeat(ups) + found;
        }
        changed = true;
        fixed++;
        messages.push(`  ${c.green}✓${c.reset} ${mdFile}: "${cleanTarget}" → "${newTarget}"`);
        return `[${text}](${newTarget})`;
      }

      return match;
    });

    if (changed) {
      writeFileSync(fullPath, content);
    }
  }

  return { fixed, messages };
}
