# vet case study: mckaywrigley/chatbot-ui

**repo:** https://github.com/mckaywrigley/chatbot-ui
**description:** AI chat interface supporting OpenAI, Anthropic, Google, Mistral, Groq, Perplexity, and more
**language:** TypeScript/Next.js (258 files)
**scanned:** 2026-03-08
**vet version:** v1.6.1

## overall score: 71/100 (grade C)

| category | score | weight |
|----------|-------|--------|
| security | 68/100 | 30% |
| integrity | 78/100 | 30% |
| debt | 48/100 | 25% |
| deps | 100/100 | 15% |

## version history

| version | score | grade | deps | change |
|---------|-------|-------|------|--------|
| v1.5.0 | 56 | D | 0/100 | baseline |
| v1.6.0 | 56 | D | 0/100 | dist not rebuilt, no change |
| v1.6.1 | 71 | C | 100/100 | false positives fixed, +15 points |

## false positives fixed in v1.6.1

| finding | type | v1.6.0 | v1.6.1 |
|---------|------|--------|--------|
| `"ai"` typosquat of `"joi"` | false positive | present | **gone** |
| `"clsx"` typosquat of `"tsx"` | false positive | present | **gone** |
| 9x `@/` phantom imports | false positive | present | **gone** |

all 11 deps false positives eliminated. deps score went from 0/100 to 100/100, boosting overall from 56 (D) to 71 (C).

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

the grade jump from D to C reflects the actual codebase quality now that deps false positives are gone. the integrity and debt findings remain legitimate — this codebase has serious error handling gaps and heavy duplication.
