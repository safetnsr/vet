import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readFile, walkFiles, c } from '../util.js';

// Generate or enrich CLAUDE.md from codebase analysis
export function fixConfig(cwd: string): { fixed: number; messages: string[] } {
  const messages: string[] = [];
  let fixed = 0;
  const files = walkFiles(cwd);

  // Detect project context
  const pkgJson = readFile(join(cwd, 'package.json'));
  const deps: Record<string, string> = {};
  let projectName = 'project';
  let scripts: Record<string, string> = {};

  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      projectName = pkg.name || 'project';
      Object.assign(deps, pkg.dependencies, pkg.devDependencies);
      scripts = pkg.scripts || {};
    } catch { /* */ }
  }

  // Detect frameworks
  const detected: { name: string; rules: string[] }[] = [];

  if (deps.react || deps['react-dom']) {
    const rules = ['use functional components with hooks', 'prefer named exports for components'];
    if (deps.next) rules.push('use App Router conventions (layout.tsx, page.tsx, loading.tsx)');
    detected.push({ name: deps.next ? 'Next.js + React' : 'React', rules });
  }
  if (deps.vue) detected.push({ name: 'Vue', rules: ['use Composition API', 'keep components in SFC format'] });
  if (deps.svelte) detected.push({ name: 'SvelteKit', rules: ['use +page.svelte conventions'] });
  if (deps.hono) detected.push({ name: 'Hono', rules: ['use c.json() for responses', 'add specific routes before dynamic routes'] });
  if (deps.express) detected.push({ name: 'Express', rules: ['use router.use() for middleware', 'error middleware last'] });
  if (deps.fastify) detected.push({ name: 'Fastify', rules: ['use schema validation on routes'] });

  // Testing
  if (deps.vitest) detected.push({ name: 'Vitest', rules: ['write tests in *.test.ts files', 'use describe/it/expect pattern'] });
  else if (deps.jest) detected.push({ name: 'Jest', rules: ['write tests in *.test.ts files', 'use describe/it/expect pattern'] });

  // Database
  if (deps.prisma || deps['@prisma/client']) detected.push({ name: 'Prisma', rules: ['run prisma generate after schema changes', 'use transactions for multi-step mutations'] });
  if (deps['drizzle-orm']) detected.push({ name: 'Drizzle', rules: ['define schema in src/db/schema.ts'] });

  // Styling
  if (deps.tailwindcss) detected.push({ name: 'Tailwind CSS', rules: ['use utility classes, avoid custom CSS where possible'] });

  // TypeScript
  const tsconfig = readFile(join(cwd, 'tsconfig.json'));
  let tsStrict = false;
  if (tsconfig) {
    try { tsStrict = JSON.parse(tsconfig).compilerOptions?.strict === true; } catch { /* */ }
  }
  if (deps.typescript || tsconfig) {
    const rules = ['use TypeScript for all new files'];
    if (tsStrict) rules.push('strict mode enabled — no `any` types, explicit return types on exports');
    detected.push({ name: 'TypeScript', rules });
  }

  // Detect directory structure
  const dirs = new Set<string>();
  for (const f of files.slice(0, 200)) {
    const parts = f.split('/');
    if (parts.length > 1) dirs.add(parts[0]);
  }

  // Generate CLAUDE.md
  const claudePath = join(cwd, 'CLAUDE.md');
  const existingContent = readFile(claudePath);

  if (!existingContent) {
    // Generate fresh
    const lines = [`# ${projectName}\n`];

    if (detected.length > 0) {
      lines.push('## Stack');
      lines.push(detected.map(d => `- ${d.name}`).join('\n'));
      lines.push('');
    }

    if (dirs.size > 0) {
      lines.push('## Structure');
      const importantDirs = ['src', 'app', 'pages', 'components', 'lib', 'api', 'server', 'public', 'tests', 'test', 'scripts'];
      const projectDirs = [...dirs].filter(d => importantDirs.includes(d));
      if (projectDirs.length > 0) {
        lines.push(projectDirs.map(d => `- \`${d}/\``).join('\n'));
        lines.push('');
      }
    }

    lines.push('## Rules');
    lines.push('- handle errors explicitly — no empty catch blocks');
    lines.push('- no hardcoded secrets or API keys');
    lines.push('- keep functions focused and under 50 lines');

    for (const d of detected) {
      for (const rule of d.rules) {
        lines.push(`- ${rule}`);
      }
    }

    if (scripts.test) lines.push(`- run \`${scripts.test.split('&&')[0].trim()}\` before committing`);
    if (scripts.lint) lines.push(`- run \`${scripts.lint.split('&&')[0].trim()}\` to check code style`);

    lines.push('');

    writeFileSync(claudePath, lines.join('\n'));
    messages.push(`${c.green}+${c.reset} CLAUDE.md (generated from codebase: ${detected.map(d => d.name).join(', ')})`);
    fixed++;
  } else {
    // Enrich existing — append missing framework mentions
    const contentLower = existingContent.toLowerCase();
    const additions: string[] = [];

    for (const d of detected) {
      if (!contentLower.includes(d.name.toLowerCase().split(' ')[0])) {
        additions.push(`\n## ${d.name} (auto-detected)`);
        for (const rule of d.rules) {
          additions.push(`- ${rule}`);
        }
      }
    }

    if (additions.length > 0) {
      writeFileSync(claudePath, existingContent + '\n' + additions.join('\n') + '\n');
      messages.push(`${c.green}+${c.reset} CLAUDE.md enriched with ${additions.length} rules from detected stack`);
      fixed++;
    }
  }

  // Generate .cursorrules if missing
  const cursorPath = join(cwd, '.cursorrules');
  if (!existsSync(cursorPath) && detected.length > 0) {
    const lines = [`# ${projectName}\n`];
    lines.push(`${detected.map(d => d.name).join(' + ')} project.\n`);
    lines.push('## Guidelines');
    lines.push('- handle errors explicitly');
    lines.push('- no hardcoded secrets');
    for (const d of detected) {
      for (const rule of d.rules) {
        lines.push(`- ${rule}`);
      }
    }
    lines.push('');
    writeFileSync(cursorPath, lines.join('\n'));
    messages.push(`${c.green}+${c.reset} .cursorrules (generated)`);
    fixed++;
  }

  return { fixed, messages };
}
