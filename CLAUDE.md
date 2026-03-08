# CLAUDE.md — vet

vet is a zero-dependency TypeScript CLI that scores AI code health (A–F) across four categories: security, integrity, debt, and deps.

## Identity

- **Purpose:** AI code health scorecard — catches AI-introduced issues before they land in production
- **Package:** published as `vet` under the safetnsr npm scope, run via `npx @safetnsr/vet`
- **Language:** TypeScript strict mode, Node.js 18+, zero runtime dependencies

## Build Commands

Run these commands from the repo root:

    npm run build        compile TypeScript to dist/
    npm test             run 270+ tests via Node built-in test runner
    node dist/cli.js --pretty .    score this repo

## Architecture

- src/cli.ts — entry point, flag parsing, runs all health checks in parallel
- src/checks/ — one file per check category (owasp, integrity, deps, debt, etc.)
- src/checks/owasp.ts — thin wrapper for OWASP Agentic Top 10 checks
- src/checks/owasp/ — ASI01 through ASI10 implementation (one file per check)
- src/checks/integrity.ts — empty catches, hallucinated imports, unhandled awaits
- src/checks/deps.ts — phantom/dead/typosquat dependency detection
- src/checks/debt.ts — near-duplicates, orphaned exports, naming drift
- src/reporter.ts — pretty, JSON, badge output formats
- src/util.ts — shared helpers: gitExec, readFile, walkFiles
- src/scorer.ts — weighted score and grade computation (A=90, B=75, C=60, D=40, F=0)
- test/ — Node built-in test runner, .mjs test files

## Constraints

- Zero runtime dependencies. Do not add any npm packages.
- devDependencies only: typescript, @types/node, tsx
- All 270+ tests must pass after any change
- Build must be clean via npm run build

## Security Principles

- No credentials, tokens, or API keys stored in source or configs
- Least-privilege: this CLI reads files locally and does not accept untrusted remote input
- Input validation: all file reads are guarded with try/catch
- No untrusted content passed to shell commands
- Sanitize any user-provided paths before file operations

## Contribution Guidelines

- TypeScript strict mode; minimize use of any
- Keep functions small — vet flags files over 500 lines
- Add tests for new checks in test/
- Validate with npm run build and npm test before committing
- Commit style: type: short description (feat, fix, refactor, docs)

## Human Approval Gates

- Publish to npm requires manual review of changelog and version bump
- Destructive operations (delete, drop, remove) require explicit confirmation
- No automated deployment without human review
- CI passes all 270+ tests before merge is allowed

## Monitoring and Governance

- All changes tracked via git log and commit history
- Audit trail: each check emits structured JSON output
- Session timeout: checks abort on error, never hang indefinitely
- Budget: no external network calls except npm registry HEAD requests for dep checks
- Kill switch: ctrl-c stops all checks immediately
