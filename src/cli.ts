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
import { checkOwasp } from './checks/owasp.js';
import { checkDeps } from './checks/deps.js';
import { checkDebt } from './checks/debt.js';
import { checkIntegrity } from './checks/integrity.js';
import { checkReceipt, runReceiptCommand } from './checks/receipt.js';
import { checkMemory } from './checks/memory.js';
import { checkVerify } from './checks/verify.js';
import { checkTests } from './checks/tests.js';
import { checkMap, renderMapReport } from './checks/map.js';
import { checkPermissions } from './checks/permissions.js';
import { checkCompact, runCompactCommand } from './checks/compact.js';
import { checkSubsidy, runSubsidyCommand } from './checks/subsidy.js';
import { checkLoop, runLoopCommand } from './checks/loop.js';
import { checkBloat, runBloatCommand } from './checks/bloat.js';
import { checkCompleteness } from './checks/completeness.js';
import { score } from './scorer.js';
import { toGrade } from './categories.js';
import { reportPretty, reportJSON, reportBadge } from './reporter.js';
import { clearCache } from './file-cache.js';
import type { VetConfig, CheckResult } from './types.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('-') && !a.startsWith('--since')));
const flagMap = new Map<string, string>();

// Parse --since=value or --since value, --max-files=value
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--since=')) {
    flagMap.set('since', args[i].split('=')[1]);
  } else if (args[i] === '--since' && args[i + 1]) {
    flagMap.set('since', args[i + 1]);
    i++;
  } else if (args[i].startsWith('--plan=')) {
    flagMap.set('plan', args[i].split('=')[1]);
  } else if (args[i] === '--plan' && args[i + 1]) {
    flagMap.set('plan', args[i + 1]);
    i++;
  } else if (args[i].startsWith('--max-files=')) {
    flagMap.set('max-files', args[i].split('=')[1]);
  } else if (args[i] === '--max-files' && args[i + 1]) {
    flagMap.set('max-files', args[i + 1]);
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
    npx @safetnsr/vet map [dir]          show agent visibility map
    npx @safetnsr/vet permissions [dir]  audit Claude Code config for dangerous grants
    npx @safetnsr/vet compact [log]      compaction forensics for claude code sessions
    npx @safetnsr/vet subsidy [--plan tier] [--since date]  show AI cost vs subscription
    npx @safetnsr/vet loop [log]         /loop session forensics — per-iteration timeline
    npx @safetnsr/vet bloat              detect agent-generated code bloat

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
    --max-files N limit file scanning (default: unlimited)
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

const COMMANDS = ['init', 'receipt', 'map', 'permissions', 'compact', 'subsidy', 'loop', 'bloat'];
const command = COMMANDS.includes(positional[0]) ? positional[0] : undefined;
const cwd = resolve(positional.find(p => !COMMANDS.includes(p)) || '.');
const isCI = flags.has('--ci');
const isHook = flags.has('--hook');
const isFix = flags.has('--fix');
const isWatch = flags.has('--watch');
const isBadge = flags.has('--badge');
const isJSON = flags.has('--json') || (!process.stdout.isTTY && !flags.has('--pretty') && !isBadge);
const since = flagMap.get('since');
const maxFiles = flagMap.has('max-files') ? (parseInt(flagMap.get('max-files')!, 10) || 0) : 0;

// Load config
let config: VetConfig = {};
const configContent = readFile(resolve(cwd, '.vetrc'));
if (configContent) {
  try { config = JSON.parse(configContent); } catch { /* ignore bad config */ }
}

const ignore = config.ignore || [];

if (command === 'init') {
  try {
    const { init } = await import('./init.js');
    await init(cwd);
  } catch (e) {
    console.error(`${c.red}init failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'receipt') {
  try {
    const format = isJSON ? 'json' : 'ascii';
    await runReceiptCommand(format);
  } catch (e) {
    console.error(`${c.red}receipt failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'map') {
  try {
    const result = await checkMap(cwd);
    if (isJSON) {
      console.log(renderMapReport(result, true));
    } else {
      console.log(renderMapReport(result, false));
    }
  } catch (e) {
    console.error(`${c.red}map failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'permissions') {
  const result = checkPermissions(cwd);
  if (isJSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n  ${c.bold}vet permissions${c.reset} — ${result.summary}\n`);
    console.log(`  score: ${result.score}/100\n`);
    if (result.issues.length === 0) {
      console.log(`  ${c.green}no issues found${c.reset}\n`);
    } else {
      for (const issue of result.issues) {
        const icon = issue.severity === 'error' ? c.red + '✗' : issue.severity === 'warning' ? c.yellow + '⚠' : c.dim + 'i';
        const loc = issue.file ? ` ${c.dim}(${issue.file}${issue.line ? `:${issue.line}` : ''})${c.reset}` : '';
        console.log(`  ${icon}${c.reset} ${issue.message}${loc}`);
        if (issue.fixHint) console.log(`    ${c.dim}→ ${issue.fixHint}${c.reset}`);
      }
      console.log('');
    }
  }
  process.exit(result.score < 60 ? 1 : 0);
}

if (command === 'compact') {
  try {
    const format = isJSON ? 'json' : 'ascii';
    const sessionArg = positional.find(p => p !== 'compact' && !COMMANDS.includes(p));
    await runCompactCommand(format, sessionArg);
  } catch (e) {
    console.error(`${c.red}compact failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'subsidy') {
  try {
    const format = isJSON ? 'json' : 'ascii';
    const plan = flagMap.get('plan') || 'claude-pro';
    const since = flagMap.get('since');
    await runSubsidyCommand(format, { since, plan });
  } catch (e) {
    console.error(`${c.red}subsidy failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'loop') {
  try {
    const format = isJSON ? 'json' : 'ascii';
    const sessionArg = positional.find(p => p !== 'loop' && !COMMANDS.includes(p));
    await runLoopCommand(format, sessionArg);
  } catch (e) {
    console.error(`${c.red}loop failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'bloat') {
  try {
    const format = isJSON ? 'json' : 'ascii';
    await runBloatCommand(format);
  } catch (e) {
    console.error(`${c.red}bloat failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

if (!isGitRepo(cwd)) {
  console.error(`${c.red}not a git repository${c.reset}. vet operates on git repos.`);
  process.exit(1);
}

// --fix mode
if (isFix) {
  try {
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
  } catch (e) {
    console.error(`${c.red}fix failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

/** Run a check with a per-check timeout (30s). Returns a skip result on timeout. */
async function withTimeout(name: string, fn: () => CheckResult | Promise<CheckResult>, timeoutMs = 30_000): Promise<CheckResult> {
  return new Promise<CheckResult>((res) => {
    const timer = setTimeout(() => {
      if (!isJSON) console.error(`  ${c.yellow}⚠ ${name} check timed out after ${timeoutMs / 1000}s — skipped${c.reset}`);
      res({ name, score: 100, maxScore: 100, issues: [], summary: `skipped (timeout after ${timeoutMs / 1000}s)` });
    }, timeoutMs);
    Promise.resolve(fn()).then((r) => { clearTimeout(timer); res(r); }).catch(() => { clearTimeout(timer); res({ name, score: 100, maxScore: 100, issues: [], summary: 'check failed' }); });
  });
}

async function runChecks(): Promise<ReturnType<typeof score>> {
  const globalStart = Date.now();
  const GLOBAL_TIMEOUT = 120_000;
  try {

  // Check file count and warn if large
  if (maxFiles > 0) {
    const { walkFiles: wf } = await import('./util.js');
    const allProjectFiles = wf(cwd, [], maxFiles);
    if (allProjectFiles.length >= maxFiles) {
      if (!isJSON) console.log(`  ${c.yellow}Large project (${allProjectFiles.length}+ files) — scanning first ${maxFiles} files. Use --max-files to increase.${c.reset}\n`);
    }
  }

  // Run ALL independent checks in parallel
  const [
    scanResult,
    secretsResult,
    configResult,
    modelsResult,
    owaspResult,
    permissionsResult,
    integrityResult,
    readyResult,
    debtResult,
    depsResult,
    receiptResult,
    compactResult,
    subsidyResult,
    memoryResult,
    verifyResult,
    testsResult,
    loopResult,
    completenessResult,
    bloatResult,
  ] = await Promise.all([
    withTimeout('scan', () => checkScan(cwd)),
    withTimeout('secrets', () => checkSecrets(cwd)),
    withTimeout('config', () => checkConfig(cwd, ignore)),
    withTimeout('models', () => checkModels(cwd, ignore)),
    withTimeout('owasp', () => checkOwasp(cwd)),
    withTimeout('permissions', () => checkPermissions(cwd)),
    withTimeout('integrity', () => checkIntegrity(cwd, ignore)),
    withTimeout('ready', () => checkReady(cwd, ignore)),
    withTimeout('debt', () => checkDebt(cwd, ignore)),
    withTimeout('deps', () => checkDeps(cwd)),
    withTimeout('receipt', () => checkReceipt(cwd)),
    withTimeout('compact', () => checkCompact(cwd)),
    withTimeout('subsidy', () => checkSubsidy(cwd)),
    withTimeout('memory', () => checkMemory(cwd)),
    withTimeout('verify', () => checkVerify(cwd, since)),
    withTimeout('tests', () => checkTests(cwd, ignore)),
    withTimeout('loop', () => checkLoop(cwd)),
    withTimeout('completeness', () => checkCompleteness(cwd, ignore)),
    withTimeout('bloat', () => checkBloat(cwd)),
  ]);

  // Git-dependent checks (diff + history) — parallel with each other
  const [diffResult, historyResult] = await Promise.all([
    withTimeout('diff', () => checkDiff(cwd, { since })),
    withTimeout('history', () => checkHistory(cwd)),
  ]);

  // Clear file cache after all checks complete
  clearCache();

  return score(cwd, {
    security: [scanResult, secretsResult, configResult, modelsResult, owaspResult, permissionsResult, subsidyResult],
    integrity: [diffResult, integrityResult, receiptResult, compactResult, memoryResult, verifyResult, testsResult, loopResult, completenessResult],
    debt: [readyResult, historyResult, debtResult, bloatResult],
    deps: [depsResult],
  });
  } catch (e) {
    console.error('check failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// --badge mode
if (isBadge && !isWatch) {
  try {
    const result = await runChecks();
    console.log(reportBadge(result));
  } catch (e) {
    console.error(`${c.red}badge failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
  process.exit(0);
}

// --watch mode
if (isWatch) {
  try {
    console.clear();
    let result = await runChecks();
    console.log(reportPretty(result));
    console.log(`  ${c.dim}watching for changes... (ctrl+c to stop)${c.reset}\n`);

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const { watch } = await import('node:fs');

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
  try {
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
  } catch (e) {
    console.error(`${c.red}vet failed:${c.reset}`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
