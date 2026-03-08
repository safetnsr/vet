import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { readTextFile, type OwaspFinding } from './shared.js';

// ── ASI06 — Memory and Context Poisoning ─────────────────────────────────────

export function checkASI06(cwd: string): { findings: OwaspFinding[]; deduction: number } {
  const findings: OwaspFinding[] = [];
  let deduction = 0;

  const memoryPaths = [
    '.claude/memory',
    '.cursor/memory',
    'memory',
    '.aider.chat.history.md',
    '.continue/memory',
    'agent-memory',
    'context-store',
  ];

  const gitignorePath = join(cwd, '.gitignore');
  let gitignoreContent = '';
  try {
    gitignoreContent = readFileSync(gitignorePath, 'utf-8');
  } catch { /* intentional: .gitignore may not exist */ }

  for (const memPath of memoryPaths) {
    const full = join(cwd, memPath);
    if (!existsSync(full)) continue;

    const isIgnored = gitignoreContent.includes(memPath) || gitignoreContent.includes(memPath.split('/')[0]);

    if (!isIgnored) {
      findings.push({
        asiId: 'ASI06',
        severity: 'warning',
        message: `ASI06: agent memory path "${memPath}" is not in .gitignore — could be poisoned via PR`,
        file: memPath,
        fixHint: 'add agent memory directories to .gitignore to prevent context poisoning via PRs',
      });
      deduction += 8;
    }
  }

  const ragPatterns = ['.continue/config.json', '.cursor/settings.json'];
  for (const ragPath of ragPatterns) {
    const full = join(cwd, ragPath);
    if (!existsSync(full)) continue;
    const content = readTextFile(full);
    if (!content) continue;

    const hasRag = /embed|rag|retrieval|vector|index/i.test(content);
    const hasFiltering = /filter|sanitize|validate|allowlist|blocklist/i.test(content);

    if (hasRag && !hasFiltering) {
      findings.push({
        asiId: 'ASI06',
        severity: 'warning',
        message: `ASI06: RAG/embedding config "${ragPath}" has no input filtering`,
        file: ragPath,
        fixHint: 'add input filtering and validation for RAG/embedding sources to prevent context poisoning',
      });
      deduction += 8;
    }
  }

  return { findings, deduction };
}
