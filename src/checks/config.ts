import { join, basename } from 'node:path';
import type { CheckResult, Issue } from '../types.js';
import { readFile, fileExists, walkFiles } from '../util.js';

// Known agent config files per platform
const AGENT_CONFIGS: Record<string, { files: string[]; name: string }> = {
  claude: { files: ['CLAUDE.md', '.claude/settings.json', 'AGENTS.md'], name: 'Claude Code' },
  cursor: { files: ['.cursorrules', '.cursor/rules'], name: 'Cursor' },
  copilot: { files: ['.github/copilot-instructions.md'], name: 'GitHub Copilot' },
  aider: { files: ['.aider.conf.yml', '.aiderignore'], name: 'Aider' },
  continue: { files: ['.continue/config.json', '.continuerules'], name: 'Continue' },
  codex: { files: ['AGENTS.md', 'codex.md'], name: 'OpenAI Codex' },
  windsurf: { files: ['.windsurfrules'], name: 'Windsurf' },
  cline: { files: ['.clinerules', '.cline/settings.json'], name: 'Cline' },
};

export function checkConfig(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);

  // Detect which agents have config
  const detected: string[] = [];
  const missing: string[] = [];

  for (const [agent, info] of Object.entries(AGENT_CONFIGS)) {
    const found = info.files.some(f => fileExists(join(cwd, f)));
    if (found) detected.push(info.name);
  }

  if (detected.length === 0) {
    issues.push({
      severity: 'warning',
      message: 'no AI agent config found — add CLAUDE.md, .cursorrules, or similar to guide AI behavior',
      fixable: true,
      fixHint: 'run vet init to generate agent config',
    });
  }

  // Check quality of found configs
  for (const [agent, info] of Object.entries(AGENT_CONFIGS)) {
    for (const configFile of info.files) {
      const content = readFile(join(cwd, configFile));
      if (!content) continue;

      // Too short to be useful
      if (content.length < 50) {
        issues.push({
          severity: 'warning',
          message: `${configFile} is only ${content.length} chars — probably too sparse to guide AI effectively`,
          file: configFile,
          fixable: false,
        });
      }

      // Check if config mentions key project patterns
      const pkgJson = readFile(join(cwd, 'package.json'));
      if (pkgJson) {
        try {
          const pkg = JSON.parse(pkgJson);
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };

          // Major frameworks that should be mentioned
          const frameworks: Record<string, string[]> = {
            react: ['react', 'jsx', 'tsx', 'component'],
            next: ['next', 'nextjs', 'app router', 'pages router'],
            vue: ['vue', 'composition api', 'options api'],
            svelte: ['svelte', 'sveltekit'],
            express: ['express', 'middleware', 'router'],
            hono: ['hono'],
            fastify: ['fastify'],
            django: ['django'],
            flask: ['flask'],
          };

          const contentLower = content.toLowerCase();
          for (const [framework, keywords] of Object.entries(frameworks)) {
            if (deps[framework] && !keywords.some(k => contentLower.includes(k))) {
              issues.push({
                severity: 'info',
                message: `${configFile} doesn't mention ${framework} — but it's in your dependencies`,
                file: configFile,
                fixable: false,
              });
            }
          }
        } catch { /* invalid package.json, skip */ }
      }
    }
  }

  // Check for .gitignore (agents need to know what to ignore)
  if (!fileExists(join(cwd, '.gitignore'))) {
    issues.push({
      severity: 'info',
      message: 'no .gitignore — agents may create files in wrong directories',
      fixable: false,
    });
  }

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const infos = issues.filter(i => i.severity === 'info').length;
  const score = Math.max(0, Math.min(10, 10 - errors * 2 - warnings * 1.5 - infos * 0.3));

  const configSummary = detected.length > 0 ? `configs: ${detected.join(', ')}` : 'no agent configs';

  return {
    name: 'config',
    score: Math.round(score * 10) / 10,
    maxScore: 10,
    issues,
    summary: issues.length === 0 ? `${configSummary} — well configured` : `${configSummary} — ${issues.length} suggestions`,
  };
}
