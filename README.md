# vet

vet your AI-generated code. one command, nine checks, zero config.

```bash
npx @safetnsr/vet
```

works with Claude Code, Cursor, Copilot, Codex, Aider, Windsurf, Cline — anything that writes code in a git repo.

## what it checks

| check | what | how |
|-------|------|-----|
| **ready** | is your codebase AI-friendly? | scans structure, docs, types, tests |
| **diff** | did the AI leave anti-patterns? | AI-specific patterns: wholesale rewrites, orphaned imports, catch-alls, over-commenting, plus secrets & stubs |
| **models** | using deprecated AI models? | scans code for sunset model strings across OpenAI, Anthropic, Google, Cohere |
| **config** | agent configs in place? | deep analysis of CLAUDE.md, .cursorrules, copilot-instructions — checks completeness, consistency, and specificity against your actual codebase |
| **history** | git patterns healthy? | analyzes commit churn, AI attribution, large changes |
| **scan** | malicious patterns in agent configs? | scans .claude/, .cursorrules, CLAUDE.md, .mcp/ for prompt injection, shell injection, exfiltration endpoints |
| **secrets** | leaked secrets in build output? | scans dist/, build/, .next/ + .env files for API keys, tokens, connection strings using pattern + entropy analysis |
| **receipt** | what did the last agent session do? | parses ~/.claude/projects/ JSONL session logs — files changed, commands run, packages installed, SHA256 integrity hash |
| **debt** | AI-generated technical debt (duplicates, orphans, wrappers) | detects near-duplicate functions, orphaned exports, wrapper pass-throughs, naming drift |

## usage

```bash
# run all checks
npx @safetnsr/vet

# check a specific directory
npx @safetnsr/vet ./my-project

# auto-fix: generate CLAUDE.md, .cursorrules, fix deprecated models
npx @safetnsr/vet --fix

# check specific commit range
npx @safetnsr/vet --since HEAD~5

# live monitoring during AI sessions
npx @safetnsr/vet --watch

# CI mode — exit code 1 if score below threshold
npx @safetnsr/vet --ci

# JSON output
npx @safetnsr/vet --json

# generate configs + pre-commit hook
npx @safetnsr/vet init

# show last agent session receipt (ASCII or JSON)
npx @safetnsr/vet receipt
npx @safetnsr/vet receipt --json
```

## output

```
  my-project  7.5/10

  ready       ████░░░░░░   4    3 readiness issues
  diff        ████████░░   8    3 issues (2 AI-specific) in 5 files
  models      ██████████  10    all models current
  config      ███░░░░░░░   3    Cursor — needs work (3/10)
  history     █████████░   9    41 commits (~15% AI-attributed)
  scan        ██████████  10    no malicious patterns found
  secrets     ██████████  10    no leaked secrets
  receipt     ██████████  10    last session: 3 files, 2 commands

  ✗ no README — AI agents have no project context
  ✗ no tests — AI agents produce better code when tests exist
  ! [ai] wholesale rewrite: 40 lines removed, 45 added in utils.ts
  ! [ai] imported "lodash" but never used in new code

  run --fix to auto-repair 4 issues
```

## --fix

`vet --fix` analyzes your codebase and generates project-specific configs:

```bash
$ npx @safetnsr/vet --fix

  vet --fix

  + CLAUDE.md (generated from codebase: Next.js + React, Vitest, Tailwind CSS, TypeScript)
  + .cursorrules (generated)
  ✓ src/api.ts: "gpt-3.5-turbo" → "gpt-4o-mini"

  fixed 3 issues
```

the generated CLAUDE.md includes your actual stack, directory structure, and framework-specific rules.

## AI-specific diff patterns

| pattern | what it catches |
|---------|----------------|
| `[ai] wholesale rewrite` | AI rewrote an entire function when a small edit would suffice |
| `[ai] orphaned imports` | AI added imports it never uses |
| `[ai] catch-all handling` | `catch(e) { console.error(e) }` instead of specific error handling |
| `[ai] comment density` | AI over-commented obvious code |
| `[ai] empty test body` | AI stubbed a test without implementation |
| `[ai] trivial assertion` | `expect(true).toBe(true)` — test proves nothing |

## config analysis

the config check does deep analysis — not just "does CLAUDE.md exist":

```
config score breakdown:
  completeness:  4/10 — mentions typescript but not react, vitest
  consistency:   7/10 — "strict TS" but tsconfig.strict is false
  specificity:   3/10 — generic rules, nothing project-specific
```

## subcommands

### `vet receipt`

Shows a receipt for the last Claude Code agent session — what files it touched, what commands it ran, what packages it installed, plus a SHA256 integrity hash:

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

## config

create `.vetrc` in your project root (optional):

```json
{
  "checks": ["ready", "diff", "models", "config", "history", "scan", "secrets", "receipt"],
  "ignore": ["vendor/", "generated/"],
  "thresholds": { "min": 6 }
}
```

## ci

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

## zero dependencies

vet uses only Node.js built-ins. no runtime dependencies. works with Node 18+.

## license

MIT
