import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { c, readFile } from './util.js';

export async function init(cwd: string): Promise<void> {
  let created = 0;

  // 1. Create .vetrc
  const vetrcPath = join(cwd, '.vetrc');
  if (!existsSync(vetrcPath)) {
    writeFileSync(vetrcPath, JSON.stringify({
      checks: ['ready', 'diff', 'models', 'links', 'config', 'history'],
      ignore: [],
      thresholds: { min: 6 },
    }, null, 2) + '\n');
    console.log(`  ${c.green}+${c.reset} .vetrc`);
    created++;
  }

  // 2. Detect project type and create CLAUDE.md if missing
  const claudeMd = join(cwd, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    const projectContext = detectProject(cwd);
    writeFileSync(claudeMd, generateClaudeMd(projectContext));
    console.log(`  ${c.green}+${c.reset} CLAUDE.md`);
    created++;
  }

  // 3. Create .cursorrules if missing
  const cursorRules = join(cwd, '.cursorrules');
  if (!existsSync(cursorRules)) {
    const projectContext = detectProject(cwd);
    writeFileSync(cursorRules, generateCursorRules(projectContext));
    console.log(`  ${c.green}+${c.reset} .cursorrules`);
    created++;
  }

  // 4. Add pre-commit hook if .git exists
  const hooksDir = join(cwd, '.git', 'hooks');
  const preCommit = join(hooksDir, 'pre-commit');
  if (existsSync(join(cwd, '.git')) && !existsSync(preCommit)) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(preCommit, `#!/bin/sh
# vet pre-commit hook — checks AI-generated code before committing
npx @safetnsr/vet --ci --json > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "vet: score below threshold. run 'npx @safetnsr/vet' to see details."
  exit 1
fi
`);
    const { chmodSync } = await import('node:fs');
    chmodSync(preCommit, 0o755);
    console.log(`  ${c.green}+${c.reset} .git/hooks/pre-commit`);
    created++;
  }

  if (created === 0) {
    console.log(`  ${c.dim}everything already set up${c.reset}`);
  } else {
    console.log(`\n  ${c.green}initialized ${created} file${created > 1 ? 's' : ''}${c.reset}`);
  }
}

interface ProjectContext {
  name: string;
  language: 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'java' | 'unknown';
  framework?: string;
  hasTests: boolean;
}

function detectProject(cwd: string): ProjectContext {
  const ctx: ProjectContext = { name: 'project', language: 'unknown', hasTests: false };

  const pkgJson = readFile(join(cwd, 'package.json'));
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      ctx.name = pkg.name || 'project';
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      ctx.language = deps.typescript ? 'typescript' : 'javascript';
      if (deps.react) ctx.framework = 'react';
      if (deps.next) ctx.framework = 'next.js';
      if (deps.vue) ctx.framework = 'vue';
      if (deps.svelte) ctx.framework = 'svelte';
      if (deps.express) ctx.framework = 'express';
      if (deps.hono) ctx.framework = 'hono';
      if (deps.fastify) ctx.framework = 'fastify';
      if (pkg.scripts?.test) ctx.hasTests = true;
    } catch { /* */ }
  }

  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) ctx.language = 'python';
  if (existsSync(join(cwd, 'Cargo.toml'))) ctx.language = 'rust';
  if (existsSync(join(cwd, 'go.mod'))) ctx.language = 'go';

  return ctx;
}

function generateClaudeMd(ctx: ProjectContext): string {
  const lines = [`# ${ctx.name}\n`];
  lines.push(`## Project`);
  lines.push(`- Language: ${ctx.language}`);
  if (ctx.framework) lines.push(`- Framework: ${ctx.framework}`);
  lines.push('');
  lines.push(`## Rules`);
  lines.push(`- Keep functions small and focused`);
  lines.push(`- Handle errors explicitly — no empty catch blocks`);
  lines.push(`- No hardcoded secrets or API keys`);
  if (ctx.hasTests) lines.push(`- Write tests for new functionality`);
  if (ctx.language === 'typescript') lines.push(`- Use strict TypeScript — no \`any\` types`);
  lines.push('');
  return lines.join('\n');
}

function generateCursorRules(ctx: ProjectContext): string {
  const lines = [`# ${ctx.name}\n`];
  if (ctx.framework) lines.push(`This is a ${ctx.framework} project using ${ctx.language}.`);
  else lines.push(`This is a ${ctx.language} project.`);
  lines.push('');
  lines.push('## Guidelines');
  lines.push('- Keep functions small and focused');
  lines.push('- Handle errors explicitly');
  lines.push('- No hardcoded secrets');
  if (ctx.hasTests) lines.push('- Maintain test coverage');
  lines.push('');
  return lines.join('\n');
}
