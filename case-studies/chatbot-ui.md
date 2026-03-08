# vet case study: mckaywrigley/chatbot-ui

**repo:** https://github.com/mckaywrigley/chatbot-ui
**description:** AI chat interface supporting OpenAI, Anthropic, Google, Mistral, Groq, Perplexity, and more
**language:** TypeScript/Next.js (258 files)
**scanned:** 2026-03-08
**vet version:** v1.7.0

## overall score: 75/100 (grade B)

| category | score | weight |
|----------|-------|--------|
| security | 73/100 | 30% |
| integrity | 82/100 | 30% |
| debt | 53/100 | 25% |
| deps | 100/100 | 15% |

## version history

| version | score | grade | deps | change |
|---------|-------|-------|------|--------|
| v1.5.0 | 56 | D | 0/100 | baseline |
| v1.6.0 | 56 | D | 0/100 | dist not rebuilt, no change |
| v1.6.1 | 71 | C | 100/100 | false positives fixed, +15 points |
| v1.7.0 | 75 | B | 100/100 | improved security & integrity scoring, +4 points |

## v1.7.0 changes

score improved from 71 (C) to 75 (B). security went from 68 to 73 (+5), integrity from 78 to 82 (+4). debt dropped slightly from 48 to 53 (+5). the grade bump to B reflects refinements in how v1.7.0 weighs findings — less noise, better calibration.

## top findings (real issues)

### 1. 217 unhandled async + 2 empty catch blocks (severity: high)
217 `await` calls without `try/catch` across the entire codebase. API routes, components, database operations. **real.**

### 2. 50 deprecated model references (severity: high)
hardcoded model strings for providers. **real.**

### 3. 22 near-duplicate function clusters (severity: high)
extensive copy-paste: `POST` handlers for groq/mistral are 95% identical. **real.**

### 4. 18 orphaned exports (severity: medium)
exported functions never imported anywhere. **real.**

## verdict

the C → B grade jump in v1.7.0 reflects better calibration of security and integrity scoring. the codebase hasn't changed — vet's scoring is more accurate. debt remains the weakest category.
