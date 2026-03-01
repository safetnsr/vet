#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, watchFile, statSync } from 'node:fs';
import { isGitRepo, readFile, c } from './util.js';
import { checkReady } from './checks/ready.js';
import { checkDiff } from './checks/diff.js';
import { checkModels } from './checks/models.js';
import { checkLinks } from './checks/links.js';
import { checkConfig } from './checks/config.js';
import { checkHistory } from './checks/history.js';
import { score } from './scorer.js';
import { reportPretty, reportJSON } from './reporter.js';
import type { VetConfig, CheckResult } from './types.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('-') && !a.startsWith('--since')));
const flagMap = new Map<string, string>();

// Parse --since=value or --since value
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--since=')) {
    flagMap.set('since', args[i].split('=')[1]);
  } else if (args[i] === '--since' && args[i + 1]) {
    flagMap.set('since', args[i + 1]);
    i++;
  }
}

const positional = args.filter(a => !a.startsWith('-'));

if (flags.has('--help') || flags.has('-h')) {
  console.log(`
  ${c.bold}vet${c.reset} — vet your AI-generated code

  ${c.dim}usage:${c.reset}
    npx @safetnsr/vet [dir]              run all checks
    npx @safetnsr/vet --fix              auto-repair fixable issues
    npx @safetnsr/vet --ci               exit code 1 if below threshold
    npx @safetnsr/vet --since HEAD~5     check specific commit range
    npx @safetnsr/vet --watch            live monitoring during AI sessions
    npx @safetnsr/vet init               generate configs + hooks

  ${c.dim}options:${c.reset}
    --ci          CI mode (exit 1 if score < threshold)
    --fix         auto-fix configs, models, links
    --since REF   diff against specific commit/range
    --watch       re-run on file changes
    --json        JSON output
    --pretty      force pretty output (even in pipes)
    -h, --help    show this help
    -v, --version show version
`);
  process.exit(0);
}

if (flags.has('--version') || flags.has('-v')) {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    console.log(pkg.version);
  } catch {
    console.log('0.2.0');
  }
  process.exit(0);
}

const COMMANDS = ['init'];
const command = COMMANDS.includes(positional[0]) ? positional[0] : undefined;
const cwd = resolve(positional.find(p => !COMMANDS.includes(p)) || '.');
const isCI = flags.has('--ci');
const isFix = flags.has('--fix');
const isWatch = flags.has('--watch');
const isJSON = flags.has('--json') || (!process.stdout.isTTY && !flags.has('--pretty'));
const since = flagMap.get('since');

// Load config
let config: VetConfig = {};
const configContent = readFile(resolve(cwd, '.vetrc'));
if (configContent) {
  try { config = JSON.parse(configContent); } catch { /* ignore bad config */ }
}

const ignore = config.ignore || [];

if (command === 'init') {
  const { init } = await import('./init.js');
  await init(cwd);
  process.exit(0);
}

if (!isGitRepo(cwd)) {
  console.error(`${c.red}not a git repository${c.reset}. vet operates on git repos.`);
  process.exit(1);
}

// --fix mode
if (isFix) {
  console.log(`\n  ${c.bold}vet --fix${c.reset}\n`);

  const { fixConfig } = await import('./fix/config.js');
  const { fixModels } = await import('./fix/models.js');
  const { fixLinks } = await import('./fix/links.js');

  const configResult = fixConfig(cwd);
  const modelsResult = fixModels(cwd, ignore);
  const linksResult = fixLinks(cwd, ignore);

  const allMessages = [...configResult.messages, ...modelsResult.messages, ...linksResult.messages];
  const totalFixed = configResult.fixed + modelsResult.fixed + linksResult.fixed;

  if (allMessages.length > 0) {
    for (const msg of allMessages) console.log(msg);
  }

  console.log(`\n  ${totalFixed > 0 ? c.green : c.dim}fixed ${totalFixed} issue${totalFixed !== 1 ? 's' : ''}${c.reset}\n`);
  process.exit(0);
}

async function runChecks(): Promise<ReturnType<typeof score>> {
  const allChecks = ['ready', 'diff', 'models', 'links', 'config', 'history'];
  const enabledChecks = config.checks || allChecks;
  const results: CheckResult[] = [];

  // ready and models are async (try rich subpackages first, fallback to built-in)
  if (enabledChecks.includes('ready')) results.push(await checkReady(cwd, ignore));
  if (enabledChecks.includes('diff')) results.push(checkDiff(cwd, { since }));
  if (enabledChecks.includes('models')) results.push(await checkModels(cwd, ignore));
  if (enabledChecks.includes('links')) results.push(checkLinks(cwd, ignore));
  if (enabledChecks.includes('config')) results.push(checkConfig(cwd, ignore));
  if (enabledChecks.includes('history')) results.push(checkHistory(cwd));

  return score(cwd, results);
}

// --watch mode
if (isWatch) {
  console.clear();
  let result = await runChecks();
  console.log(reportPretty(result));
  console.log(`  ${c.dim}watching for changes... (ctrl+c to stop)${c.reset}\n`);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const { watch } = await import('node:fs');

  try {
    const watcher = watch(cwd, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules') || filename.includes('.git')) return;

      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        console.clear();
        result = await runChecks();
        console.log(reportPretty(result));
        console.log(`  ${c.dim}watching for changes... (ctrl+c to stop)${c.reset}\n`);
      }, 500);
    });

    process.on('SIGINT', () => {
      watcher.close();
      process.exit(0);
    });
  } catch {
    console.error(`${c.yellow}watch mode requires Node 19+ with recursive fs.watch support${c.reset}`);
    process.exit(1);
  }
} else {
  // Normal run
  const result = await runChecks();

  if (isJSON) {
    console.log(reportJSON(result));
  } else {
    console.log(reportPretty(result));
  }

  if (isCI) {
    const threshold = config.thresholds?.min ?? 6;
    process.exit(result.score >= threshold ? 0 : 1);
  }
}
