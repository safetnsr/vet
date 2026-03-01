import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { walkFiles, readFile, c } from '../util.js';

// Same registry as checks/models.ts — inline to avoid coupling
const REPLACEMENTS: Record<string, string> = {
  'gpt-3.5-turbo': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4o',
  'gpt-4-turbo-preview': 'gpt-4o',
  'gpt-4-0314': 'gpt-4o',
  'gpt-4-0613': 'gpt-4o',
  'gpt-4-32k': 'gpt-4o',
  'text-davinci-003': 'gpt-4o-mini',
  'code-davinci-002': 'gpt-4o',
  'text-embedding-ada-002': 'text-embedding-3-small',
  'claude-instant-1': 'claude-sonnet-4-5',
  'claude-2': 'claude-sonnet-4-5',
  'claude-2.0': 'claude-sonnet-4-5',
  'claude-2.1': 'claude-sonnet-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-3-5',
  'claude-3-sonnet-20240229': 'claude-sonnet-4-5',
  'claude-3-opus-20240229': 'claude-opus-4-0',
  'gemini-pro': 'gemini-2.0-flash',
  'gemini-1.0-pro': 'gemini-2.0-flash',
  'gemini-1.5-pro': 'gemini-2.5-pro',
  'gemini-1.5-flash': 'gemini-2.0-flash',
  'text-bison': 'gemini-2.0-flash',
  'chat-bison': 'gemini-2.0-flash',
};

const SCAN_EXTS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.rb', '.php',
  '.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.conf'];
const SELF_IGNORE = ['models.ts', 'models.js', 'model-graveyard', 'model-registry', 'sunset'];

export function fixModels(cwd: string, ignore: string[]): { fixed: number; messages: string[] } {
  const messages: string[] = [];
  let fixed = 0;
  const files = walkFiles(cwd, ignore);

  for (const f of files) {
    if (!SCAN_EXTS.some(ext => f.endsWith(ext))) continue;
    if (SELF_IGNORE.some(s => f.toLowerCase().includes(s))) continue;

    const fullPath = join(cwd, f);
    const raw = readFile(fullPath);
    if (!raw) continue;
    let content: string = raw;

    let changed = false;
    for (const [old, replacement] of Object.entries(REPLACEMENTS)) {
      if (content.includes(old)) {
        const regex = new RegExp(`(['"\`])${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');
        const updated = content.replace(regex, `$1${replacement}$1`);
        if (updated !== content) {
          content = updated;
          changed = true;
          messages.push(`  ${c.green}✓${c.reset} ${f}: "${old}" → "${replacement}"`);
          fixed++;
        }
      }
    }

    if (changed) {
      writeFileSync(fullPath, content);
    }
  }

  return { fixed, messages };
}
