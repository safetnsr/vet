# vet

your AI coding agent doesn't know what it broke. you need a second opinion.

![vet demo](demo.gif)

```bash
npx @safetnsr/vet
```

vet checks your codebase **before** and **after** AI coding sessions. before: is your repo set up so the agent does good work? after: did it leave behind anti-patterns, stale tests, leaked secrets, or technical debt?

works with Claude Code, Cursor, Copilot, Codex, Aider, Windsurf, Cline — anything that writes code in a git repo.

## two flows, one command

`npx @safetnsr/vet` runs everything. but the checks split into two categories:

### before the session — is your codebase ready?

| check | what it does |
|-------|-------------|
| **ready** | scores your codebase structure: docs, types, tests, AI-friendliness |
| **config** | deep analysis of CLAUDE.md, .cursorrules, copilot-instructions — completeness, consistency, specificity |
| **scan** | detects prompt injection, shell injection, exfiltration in agent config files |
| **permissions** | flags MCP servers with dangerous filesystem access (writes to ~/.ssh, /etc, outside cwd) |
| **models** | finds deprecated/sunset model strings across OpenAI, Anthropic, Google, Cohere |
| **map** | verifies your codebase has navigable structure for agents |
| **memory** | catches stale facts, contradictions, and drift in CLAUDE.md, AGENTS.md, memory/ files |

a codebase that scores well here gives AI agents better context, fewer hallucinations, and less cleanup.

### after the session — did the AI leave problems?

| check | what it does |
|-------|-------------|
| **diff** | AI-specific anti-patterns: wholesale rewrites, orphaned imports, catch-all error handling, over-commenting |
| **tests** | test theater: tautological assertions, empty test bodies, tests that prove nothing |
| **debt** | near-duplicate functions, orphaned exports, wrapper pass-throughs, naming drift |
| **secrets** | scans dist/, build/, .next/ + .env files for leaked API keys using pattern + entropy analysis |
| **history** | git commit churn, AI attribution ratios, suspiciously large changes |
| **receipt** | parses Claude Code session logs — files changed, commands run, packages installed, SHA256 integrity hash |
| **compact** | compaction forensics — what context got dropped during Claude Code session compaction |

plus: **integrity** (hallucinated imports), **deps** (unused/phantom dependencies), **owasp** (OWASP Top 10 for AI agents), **verify** (validates agent claims against actual changes).

## output

```
  my-project  B  75/100

  security     ████████░░  82   scan ✓  secrets ✓  config 3/10  owasp ✓
  integrity    ███████░░░  68   diff: 3 issues  integrity ✓  memory: 1 stale
  debt         ██████░░░░  58   ready 4/10  history ✓  debt: 2 duplicates
  deps         ██████████  98   all clean

  ✗ no README — AI agents have no project context
  ✗ [ai] wholesale rewrite: 40 lines removed, 45 added in utils.ts
  ! config: "strict TS" but tsconfig.strict is false
  ! memory: CLAUDE.md references vitest but package.json uses jest

  run --fix to auto-repair 4 issues
```

## usage

```bash
# run all checks
npx @safetnsr/vet

# specific directory
npx @safetnsr/vet ./my-project

# auto-fix: generate CLAUDE.md, .cursorrules, fix deprecated models
npx @safetnsr/vet --fix

# specific commit range
npx @safetnsr/vet --since HEAD~5

# live monitoring during AI sessions
npx @safetnsr/vet --watch

# CI mode — exit 1 if score below threshold
npx @safetnsr/vet --ci

# JSON output
npx @safetnsr/vet --json

# generate configs + pre-commit hook
npx @safetnsr/vet init

# agent session receipt
npx @safetnsr/vet receipt
npx @safetnsr/vet receipt --json

# compaction forensics for claude sessions
npx @safetnsr/vet compact [log]
```

## --fix

analyzes your codebase and generates project-specific configs:

```bash
$ npx @safetnsr/vet --fix

  vet --fix

  + CLAUDE.md (generated: Next.js + React, Vitest, Tailwind CSS, TypeScript)
  + .cursorrules (generated)
  ✓ src/api.ts: "gpt-3.5-turbo" → "gpt-4o-mini"

  fixed 3 issues
```

the generated CLAUDE.md includes your actual stack, directory structure, and framework-specific rules — not a template.

## --watch

monitors your repo during an active AI session. re-runs checks on every file change:

```bash
npx @safetnsr/vet --watch
```

catch problems as the agent creates them, not after it's done.

## CI/CD

### Quick (one-liner)

```yaml
# .github/workflows/vet.yml
name: vet
on: [pull_request]
jobs:
  vet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 50
      - run: npx @safetnsr/vet --ci
```

### GitHub Action (with PR comments)

Posts a score card directly on your PR with pass/fail status:

```yaml
name: vet
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  vet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: safetnsr/vet/.github/actions/vet@main
        with:
          threshold: C        # minimum grade to pass (A/B/C/D/F)
          comment: true        # post score card as PR comment
```

**Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `threshold` | `C` | Minimum grade to pass |
| `working-directory` | `.` | Directory to run vet in |
| `version` | `latest` | @safetnsr/vet version |
| `comment` | `true` | Post results as PR comment |

**Outputs:** `score`, `grade`, `passed`

## config

optional `.vetrc` in your project root:

```json
{
  "checks": ["ready", "diff", "models", "config", "scan", "secrets"],
  "ignore": ["vendor/", "generated/"],
  "thresholds": { "min": 60 }
}
```

## receipt

shows what the last Claude Code session actually did — files touched, commands run, packages installed, with a SHA256 integrity hash:

```
╔══════════════════════════════════════════════╗
║          AGENT SESSION RECEIPT               ║
╠══════════════════════════════════════════════╣
║ Session:  abc123def456                       ║
║ Date:     2024-01-15 14:32:11 UTC            ║
║ Duration: 12m 34s                            ║
╠══════════════════════════════════════════════╣
║ FILES CREATED (3)                            ║
║   src/checks/scan.ts                         ║
║   src/checks/secrets.ts                      ║
║   test/scan.test.mjs                         ║
╠══════════════════════════════════════════════╣
║ SHA256: 3a7f9c2e...                          ║
╚══════════════════════════════════════════════╝
```

## zero dependencies

vet uses only Node.js built-ins. no runtime dependencies. works with Node 18+.

## license

MIT
