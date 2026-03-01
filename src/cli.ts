#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { isGitRepo, readFile } from './util.js';
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
const flags = new Set(args.filter(a => a.startsWith('-')));
const positional = args.filter(a => !a.startsWith('-'));

if (flags.has('--help') || flags.has('-h')) {
  console.log(`
  vet — vet your AI-generated code

  usage:
    npx @safetnsr/vet [dir]       run all checks (default: cwd)
    npx @safetnsr/vet --ci        exit code 1 if score < threshold
    npx @safetnsr/vet --fix       auto-repair fixable issues
    npx @safetnsr/vet --json      output JSON
    npx @safetnsr/vet init        generate .vetrc + agent config

  options:
    --ci          CI mode (exit 1 if below threshold)
    --fix         auto-fix what we can
    --json        JSON output
    --no-color    disable colors
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
    console.log('0.1.0');
  }
  process.exit(0);
}

const COMMANDS = ['init'];
const command = COMMANDS.includes(positional[0]) ? positional[0] : undefined;
const cwd = resolve(positional.find(p => !COMMANDS.includes(p)) || '.');
const isCI = flags.has('--ci');
const isFix = flags.has('--fix');
const isJSON = flags.has('--json') || (!process.stdout.isTTY && !flags.has('--pretty'));

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

// Run checks
if (!isGitRepo(cwd)) {
  console.error('not a git repository. vet operates on git repos.');
  process.exit(1);
}

const allChecks = ['ready', 'diff', 'models', 'links', 'config', 'history'];
const enabledChecks = config.checks || allChecks;

const results: CheckResult[] = [];

if (enabledChecks.includes('ready')) results.push(checkReady(cwd, ignore));
if (enabledChecks.includes('diff')) results.push(checkDiff(cwd));
if (enabledChecks.includes('models')) results.push(checkModels(cwd, ignore));
if (enabledChecks.includes('links')) results.push(checkLinks(cwd, ignore));
if (enabledChecks.includes('config')) results.push(checkConfig(cwd, ignore));
if (enabledChecks.includes('history')) results.push(checkHistory(cwd));

const result = score(cwd, results);

if (isJSON) {
  console.log(reportJSON(result));
} else {
  console.log(reportPretty(result));
}

// CI exit code
if (isCI) {
  const threshold = config.thresholds?.min ?? 6;
  process.exit(result.score >= threshold ? 0 : 1);
}
