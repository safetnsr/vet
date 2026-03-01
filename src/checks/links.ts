import { join, dirname } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { readFile, fileExists, walkFiles } from '../util.js';

// Markdown link checker — broken relative links and wikilinks
export function checkLinks(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);
  const mdFiles = files.filter(f => f.endsWith('.md'));

  if (mdFiles.length === 0) {
    return { name: 'links', score: 10, maxScore: 10, issues: [], summary: 'no markdown files to check' };
  }

  const allFilesSet = new Set(files);
  // Also index without extension for wikilinks
  const filesByName = new Map<string, string>();
  for (const f of files) {
    const base = f.replace(/\.[^.]+$/, '');
    filesByName.set(base.toLowerCase(), f);
    // Also just the filename
    const name = f.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    if (name) filesByName.set(name.toLowerCase(), f);
  }

  for (const mdFile of mdFiles) {
    const content = readFile(join(cwd, mdFile));
    if (!content) continue;
    const dir = dirname(mdFile);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Standard markdown links: [text](path)
      const mdLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
      let match;
      while ((match = mdLinkRegex.exec(line)) !== null) {
        const target = match[2].split('#')[0].split('?')[0]; // strip anchors/queries
        if (!target) continue; // anchor-only link
        if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) continue;
        if (target.startsWith('/images/') || target.startsWith('/assets/')) continue; // common static paths

        const resolved = join(dir, target);
        if (!allFilesSet.has(resolved) && !fileExists(join(cwd, resolved))) {
          issues.push({
            severity: 'warning',
            message: `broken link to "${target}"`,
            file: mdFile,
            line: i + 1,
            fixable: false,
          });
        }
      }

      // Wikilinks: [[target]]
      const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      while ((match = wikiRegex.exec(line)) !== null) {
        const target = match[1].trim().toLowerCase();
        if (!filesByName.has(target) && !allFilesSet.has(target + '.md')) {
          issues.push({
            severity: 'warning',
            message: `broken wikilink [[${match[1].trim()}]]`,
            file: mdFile,
            line: i + 1,
            fixable: false,
          });
        }
      }
    }
  }

  const score = Math.max(0, 10 - issues.length * 0.5);

  return {
    name: 'links',
    score: Math.round(Math.min(10, score) * 10) / 10,
    maxScore: 10,
    issues,
    summary: issues.length === 0 ? `${mdFiles.length} markdown files, all links valid` : `${issues.length} broken link${issues.length > 1 ? 's' : ''} across ${mdFiles.length} files`,
  };
}
