#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, watchFile, statSync } from 'node:fs';
import { isGitRepo, readFile, c } from './util.js';
import { checkReady } from './checks/ready.js';
import { checkDiff } from './checks/diff.js';
import { checkModels } from './checks/models.js';
import { checkConfig } from './checks/config.js';
import { checkHistory } from './checks/history.js';
import { checkScan } from './checks/scan.js';
import { checkSecrets } from './checks/secrets.js';
import { checkDeps } from './checks/deps.js';
import { checkDebt } from './checks/debt.js';
import { checkIntegrity } from './checks/integrity.js';
import { checkReceipt, runReceiptCommand } from './checks/receipt.js';
import { score } from './scorer.js';
import { toGrade } from './categories.js';
import { reportPretty, reportJSON, reportBadge } from './reporter.js';
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
  ${c.bold}vet${c.reset} — AI code health score card

  ${c.dim}usage:${c.reset}
    npx @safetnsr/vet [dir]              run all checks, show score card
    npx @safetnsr/vet --fix              auto-repair fixable issues
    npx @safetnsr/vet --ci               exit code 1 if below grade C
    npx @safetnsr/vet --hook             pre-commit hook mode (grade C threshold)
    npx @safetnsr/vet --badge            output markdown badge string
    npx @safetnsr/vet --since HEAD~5     check specific commit range
    npx @safetnsr/vet --watch            live monitoring during AI sessions
    npx @safetnsr/vet init               generate configs + hooks
    npx @safetnsr/vet receipt            show last agent session receipt

  ${c.dim}categories:${c.reset}
    security   (30%)  scan, secrets, config, model usage
    integrity  (30%)  diff, hallucinated imports, empty catches, stubbed tests
    debt       (25%)  near-duplicates, orphaned exports, naming drift
    deps       (15%)  phantom deps, typosquats, dead deps

  ${c.dim}grades:${c.reset}
    A  ≥ 90    B  ≥ 75    C  ≥ 60    D  ≥ 40    F  < 40

  ${c.dim}options:${c.reset}
    --ci          CI mode (exit 1 if score below threshold)
    --hook        pre-commit hook mode (exit 1 if below grade C)
    --badge       print markdown badge string and exit
    --fix         auto-fix configs, models
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
    console.log('1.0.0');
  }
  process.exit(0);
}

const COMMANDS = ['init', 'receipt'];
const command = COMMANDS.includes(positional[0]) ? positional[0] : undefined;
const cwd = resolve(positional.find(p => !COMMANDS.includes(p)) || '.');
const isCI = flags.has('--ci');
const isHook = flags.has('--hook');
const isFix = flags.has('--fix');
const isWatch = flags.has('--watch');
const isBadge = flags.has('--badge');
const isJSON = flags.has('--json') || (!process.stdout.isTTY && !flags.has('--pretty') && !isBadge);
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

if (command === 'receipt') {
  const format = isJSON ? 'json' : 'ascii';
  await runReceiptCommand(format);
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
  const configResult = fixConfig(cwd);
  const modelsResult = fixModels(cwd, ignore);

  const allMessages = [...configResult.messages, ...modelsResult.messages];
  const totalFixed = configResult.fixed + modelsResult.fixed;

  if (allMessages.length > 0) {
    for (const msg of allMessages) console.log(msg);
  }

  console.log(`\n  ${totalFixed > 0 ? c.green : c.dim}fixed ${totalFixed} issue${totalFixed !== 1 ? 's' : ''}${c.reset}\n`);
  process.exit(0);
}

async function runChecks(): Promise<ReturnType<typeof score>> {
  // Run all checks, grouped into categories
  // Security: scan, secrets, config, models
  const [scanResult, secretsResult, configResult, modelsResult] = await Promise.all([
    Promise.resolve(checkScan(cwd)),
    checkSecrets(cwd),
    Promise.resolve(checkConfig(cwd, ignore)),
    checkModels(cwd, ignore),
  ]);

  // Integrity: diff, integrity checks
  const diffResult = checkDiff(cwd, { since });
  const integrityResult = await checkIntegrity(cwd, ignore);

  // Debt: ready, history, debt
  const [readyResult, debtResult] = await Promise.all([
    checkReady(cwd, ignore),
    checkDebt(cwd, ignore),
  ]);
  const historyResult = checkHistory(cwd);

  // Deps: deps
  const depsResult = await checkDeps(cwd);

  // Receipt is informational — fold into integrity category but keep low weight
  const receiptResult = await checkReceipt(cwd);

  return score(cwd, {
    security: [scanResult, secretsResult, configResult, modelsResult],
    integrity: [diffResult, integrityResult, receiptResult],
    debt: [readyResult, historyResult, debtResult],
    deps: [depsResult],
  });
}

// --badge mode
if (isBadge && !isWatch) {
  const result = await runChecks();
  console.log(reportBadge(result));
  process.exit(0);
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

  if (isCI || isHook) {
    // --hook uses grade C (60) as threshold
    // --ci uses config threshold or grade C default
    const minScore = isHook ? 60 : (config.thresholds?.min ?? 60);
    const minGrade = isHook ? 'C' : (config.thresholds?.grade ?? 'C');
    process.exit(result.score >= minScore ? 0 : 1);
  }
}
