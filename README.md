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
| **diff** | did the AI leave anti-patterns? | checks staged/unstaged changes for secrets, stubs, empty catches |
| **models** | using deprecated AI models? | scans code for sunset model strings |
| **links** | broken markdown links? | validates relative links and wikilinks |
| **config** | agent configs in place? | checks for CLAUDE.md, .cursorrules, copilot-instructions, etc. |
| **history** | git patterns healthy? | analyzes commit churn, AI attribution, large changes |

## usage

```bash
# run all checks (default)
npx @safetnsr/vet

# check a specific directory
npx @safetnsr/vet ./my-project

# CI mode — exit code 1 if score below threshold
npx @safetnsr/vet --ci

# auto-fix what we can
npx @safetnsr/vet --fix

# JSON output
npx @safetnsr/vet --json

# set up config + agent files + pre-commit hook
npx @safetnsr/vet init
```

## output

```
  my-project  8.2/10

  ready       ████████░░   8    structure + docs look good
  diff        ██████████  10    clean diff, no issues
  models      ██████████  10    all models current
  links       ██████░░░░   6    3 broken links in docs/
  config      ████████░░   8    CLAUDE.md missing react patterns
  history     ████████░░   8    2 high-churn files

  run --fix to auto-repair 4 issues
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

## init

`npx @safetnsr/vet init` creates:
- `.vetrc` with sensible defaults
- `CLAUDE.md` generated from your codebase
- `.cursorrules` matching your project
- `.git/hooks/pre-commit` that runs vet before every commit

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
