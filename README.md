# vet

vet your AI-generated code. one command, six checks, zero config.

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
| **links** | broken markdown links? | validates relative links and wikilinks |
| **config** | agent configs in place? | deep analysis of CLAUDE.md, .cursorrules, copilot-instructions — checks completeness, consistency, and specificity against your actual codebase |
| **history** | git patterns healthy? | analyzes commit churn, AI attribution, large changes |

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
```

## output

```
  my-project  6.2/10

  ready       ████░░░░░░   4    3 readiness issues
  diff        ████████░░   8    3 issues (2 AI-specific) in 5 files
  models      ██████████  10    all models current
  links       ██████░░░░   6    3 broken links in docs/
  config      ███░░░░░░░   3    Cursor — needs work (3/10)
  history     █████████░   9    41 commits (~15% AI-attributed)

  ✗ no README — AI agents have no project context
  ✗ no tests — AI agents produce better code when tests exist
  ! [ai] wholesale rewrite: 40 lines removed, 45 added in utils.ts
  ! [ai] imported "lodash" but never used in new code

  run --fix to auto-repair 4 issues
```

## --fix

`vet --fix` doesn't just scaffold — it analyzes your codebase and generates project-specific configs:

```bash
$ npx @safetnsr/vet --fix

  vet --fix

  + CLAUDE.md (generated from codebase: Next.js + React, Vitest, Tailwind CSS, TypeScript)
  + .cursorrules (generated)
  ✓ src/api.ts: "gpt-3.5-turbo" → "gpt-4o-mini"

  fixed 3 issues
```

the generated CLAUDE.md includes your actual stack, directory structure, and framework-specific rules — not generic boilerplate.

## AI-specific diff patterns

vet catches things that are specific to AI-generated code:

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

## config

create `.vetrc` in your project root (optional):

```json
{
  "checks": ["ready", "diff", "models", "links", "config", "history"],
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
