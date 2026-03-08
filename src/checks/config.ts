import { join } from 'node:path';
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

interface ConfigAnalysis {
  file: string;
  agent: string;
  length: number;
  existence: number;      // 0-10
  completeness: number;   // 0-10
  consistency: number;    // 0-10
  specificity: number;    // 0-10
  suggestions: string[];
}

function analyzeConfig(cwd: string, configFile: string, agentName: string, files: string[]): ConfigAnalysis {
  const content = readFile(join(cwd, configFile)) || '';
  const contentLower = content.toLowerCase();
  const suggestions: string[] = [];

  // Existence: it exists, so 10
  const existence = 10;

  // Completeness: does it cover the project's actual stack?
  let completenessScore = 5; // base
  let completenessChecks = 0;
  let completenessHits = 0;

  const pkgJson = readFile(join(cwd, 'package.json'));
  const deps: Record<string, string> = {};
  let projectName = '';
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      projectName = pkg.name || '';
      Object.assign(deps, pkg.dependencies, pkg.devDependencies);
    } catch { /* */ }
  }

  // Framework detection + config coverage
  const frameworkMap: Record<string, { keywords: string[]; category: string }> = {
    react: { keywords: ['react', 'jsx', 'tsx', 'component', 'hook', 'usestate', 'useeffect'], category: 'UI framework' },
    next: { keywords: ['next', 'nextjs', 'app router', 'pages router', 'server component'], category: 'framework' },
    vue: { keywords: ['vue', 'composition api', 'options api', 'ref(', 'reactive'], category: 'UI framework' },
    svelte: { keywords: ['svelte', 'sveltekit', '$:'], category: 'UI framework' },
    express: { keywords: ['express', 'middleware', 'router', 'req, res'], category: 'backend' },
    hono: { keywords: ['hono', 'c.json', 'c.text'], category: 'backend' },
    fastify: { keywords: ['fastify', 'schema', 'route'], category: 'backend' },
    vitest: { keywords: ['vitest', 'describe', 'it(', 'expect', 'test('], category: 'testing' },
    jest: { keywords: ['jest', 'describe', 'it(', 'expect', 'test('], category: 'testing' },
    tailwind: { keywords: ['tailwind', 'className', 'tw-'], category: 'styling' },
    prisma: { keywords: ['prisma', 'schema.prisma', 'prismaClient'], category: 'database' },
    drizzle: { keywords: ['drizzle', 'drizzle-orm'], category: 'database' },
  };

  for (const [dep, info] of Object.entries(frameworkMap)) {
    if (deps[dep] || deps[`@${dep}/core`] || deps[`${dep}-dom`]) {
      completenessChecks++;
      if (info.keywords.some(k => contentLower.includes(k))) {
        completenessHits++;
      } else {
        suggestions.push(`add ${dep} conventions (${info.category} detected in dependencies)`);
      }
    }
  }

  if (completenessChecks > 0) {
    completenessScore = Math.round((completenessHits / completenessChecks) * 10);
  } else {
    // No framework dependencies detected — completeness is not applicable, don't penalize
    completenessScore = 10;
  }

  // Consistency: cross-reference with actual project config
  let consistencyScore = 10;
  const tsconfig = readFile(join(cwd, 'tsconfig.json'));
  if (tsconfig) {
    try {
      const tc = JSON.parse(tsconfig);
      const strict = tc.compilerOptions?.strict;
      if (contentLower.includes('strict') && strict === false) {
        consistencyScore -= 4;
        suggestions.push('config says "strict" but tsconfig.strict is false — resolve contradiction');
      }
      if (contentLower.includes('esm') && tc.compilerOptions?.module?.toLowerCase()?.includes('commonjs')) {
        consistencyScore -= 3;
        suggestions.push('config mentions ESM but tsconfig uses CommonJS');
      }
    } catch { /* */ }
  }

  // Check if config mentions testing but no test framework installed
  // Also check if using Node's built-in test runner (node:test)
  const usesNodeTest = contentLower.includes('node:test') || contentLower.includes('node test runner') || contentLower.includes('node built-in test');
  if ((contentLower.includes('test') || contentLower.includes('spec')) && !deps.vitest && !deps.jest && !deps.mocha && !deps.ava && !usesNodeTest) {
    consistencyScore -= 2;
    suggestions.push('config mentions tests but no test framework in dependencies');
  }

  // Specificity: generic platitudes vs project-specific rules
  let specificityScore = 5;
  const genericPhrases = [
    'keep functions small', 'write clean code', 'follow best practices',
    'use meaningful names', 'handle errors', 'write tests', 'be consistent',
    'follow conventions', 'keep it simple',
  ];
  let genericCount = 0;
  for (const phrase of genericPhrases) {
    if (contentLower.includes(phrase)) genericCount++;
  }

  // Specific indicators: file paths, function names, patterns, architecture
  const specificIndicators = [
    /\.(ts|js|py|rs|go)\b/, // mentions specific file types with context
    /src\/|lib\/|app\/|pages\/|components\//, // directory structure
    /import .+ from/, // code examples
    /```/, // code blocks
    /\bapi\/|route|endpoint/i, // API patterns
    /\bmigration|schema|model\b/i, // data patterns
  ];
  let specificCount = 0;
  for (const pattern of specificIndicators) {
    if (pattern.test(content)) specificCount++;
  }

  if (genericCount > 3 && specificCount < 2) {
    specificityScore = 2;
    suggestions.push('mostly generic rules — add project-specific conventions, file paths, architecture patterns');
  } else if (specificCount >= 4) {
    specificityScore = 9;
  } else if (specificCount >= 2) {
    specificityScore = 6;
  }

  // Length-based adjustments
  if (content.length < 100) {
    specificityScore = Math.min(specificityScore, 2);
    completenessScore = Math.min(completenessScore, 2);
    suggestions.push('config is very sparse — add project context, conventions, and constraints');
  } else if (content.length < 300) {
    specificityScore = Math.min(specificityScore, 5);
    suggestions.push('config could be richer — consider adding architecture decisions and code patterns');
  }

  return {
    file: configFile,
    agent: agentName,
    length: content.length,
    existence,
    completeness: Math.max(0, completenessScore),
    consistency: Math.max(0, consistencyScore),
    specificity: Math.max(0, specificityScore),
    suggestions,
  };
}

export function checkConfig(cwd: string, ignore: string[]): CheckResult {
  const issues: Issue[] = [];
  const files = walkFiles(cwd, ignore);

  // Detect which agents have config
  const analyses: ConfigAnalysis[] = [];

  for (const [agent, info] of Object.entries(AGENT_CONFIGS)) {
    for (const configFile of info.files) {
      if (fileExists(join(cwd, configFile))) {
        analyses.push(analyzeConfig(cwd, configFile, info.name, files));
      }
    }
  }

  if (analyses.length === 0) {
    issues.push({
      severity: 'error',
      message: 'no AI agent config found — add CLAUDE.md, .cursorrules, or similar',
      fixable: true,
      fixHint: 'run vet init to generate agent config',
    });

    return {
      name: 'config',
      score: 10,
      maxScore: 100,
      issues,
      summary: 'no agent configs — critically under-configured',
    };
  }

  // Aggregate scores from best config
  const best = analyses.reduce((a, b) =>
    (a.completeness + a.consistency + a.specificity) > (b.completeness + b.consistency + b.specificity) ? a : b
  );

  // Generate issues from analysis
  if (best.completeness < 5) {
    issues.push({ severity: 'warning', message: `${best.file}: low completeness (${best.completeness}/10) — doesn't mention key dependencies`, fixable: true, fixHint: 'run vet --fix to enrich' });
  }
  if (best.consistency < 7) {
    issues.push({ severity: 'warning', message: `${best.file}: consistency issues (${best.consistency}/10) — contradicts project config`, fixable: false });
  }
  if (best.specificity < 5) {
    issues.push({ severity: 'warning', message: `${best.file}: too generic (${best.specificity}/10) — add project-specific rules`, fixable: true, fixHint: 'run vet --fix to add specifics' });
  }
  if (best.length < 100) {
    issues.push({ severity: 'warning', message: `${best.file}: only ${best.length} chars — too sparse to guide AI`, fixable: true });
  }

  for (const suggestion of best.suggestions.slice(0, 5)) {
    issues.push({ severity: 'info', message: suggestion, file: best.file, fixable: false });
  }

  // Check .gitignore
  if (!fileExists(join(cwd, '.gitignore'))) {
    issues.push({ severity: 'warning', message: 'no .gitignore — agents may write to wrong directories', fixable: false });
  }

  // Score: weighted average of sub-scores (sub-scores are 0-10, multiply by 10 → 0-100)
  const subScore = (best.existence * 0.2 + best.completeness * 0.3 + best.consistency * 0.25 + best.specificity * 0.25) * 10;
  const gitignorePenalty = fileExists(join(cwd, '.gitignore')) ? 0 : 10;
  const finalScore = Math.max(0, Math.min(100, subScore - gitignorePenalty));

  const agents = analyses.map(a => a.agent);
  const uniqueAgents = [...new Set(agents)];

  return {
    name: 'config',
    score: Math.round(finalScore),
    maxScore: 100,
    issues,
    summary: `${uniqueAgents.join(', ')} — ${best.completeness >= 7 && best.specificity >= 7 ? 'well configured' : `needs work (${Math.round(finalScore)}/10)`}`,
  };
}
