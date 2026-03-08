# vet case study: mckaywrigley/chatbot-ui

**repo:** https://github.com/mckaywrigley/chatbot-ui
**description:** AI chat interface supporting OpenAI, Anthropic, Google, Mistral, Groq, Perplexity, and more
**language:** TypeScript/Next.js (258 files)
**scanned:** 2026-03-08

## overall score: 56/100 (grade D)

| category | score | weight |
|----------|-------|--------|
| security | 68/100 | 30% |
| integrity | 78/100 | 30% |
| debt | 48/100 | 25% |
| deps | 0/100 | 15% |

## top 5 findings

### 1. 50 deprecated model references (severity: high)
chatbot-ui references 50 deprecated/sunset models. these are hardcoded model strings for providers like OpenAI, Anthropic, Google, etc. users selecting these models will get API errors at runtime.

### 2. 217 unhandled async operations + 2 empty catch blocks (severity: high)
this is the strongest finding. 217 `await` calls without `try/catch` across the entire codebase. API routes, components, database operations — almost nothing has proper error handling. the 2 empty catch blocks in `lib/supabase/server.ts` silently swallow errors.

this is a real production quality issue worth reporting.

### 3. massive code duplication — 22 near-duplicate function clusters (severity: high)
vet found extensive copy-paste patterns:
- `POST` handlers for groq/mistral routes are 95% identical
- `POST` for username/available and username/get are 99% identical
- 12 `handleKeyDown` functions across components do the same thing
- 12 `handleOpenChange`/`handleSelect` functions are near-identical
- `markAsRead`/`markAllAsRead`/`markAllAsUnread` are 91-98% similar

### 4. 18 orphaned exports + 2 wrapper pass-throughs (severity: medium)
functions exported but never imported anywhere: `getAssistantById`, `getCollectionById`, `getFileById`, `getModelById`, `getPresetById`, `getPromptById`, `getToolById`, `createXWorkspace` functions, `formatDate`, `programmingLanguages`, `generateRandomString`. dead code adding maintenance burden.

### 5. dependency issues — 2 typosquat warnings + 7 unused deps (severity: medium)
- `"ai"` flagged as possible typosquat of `"joi"` (false positive — this is Vercel's AI SDK)
- `"clsx"` flagged as possible typosquat of `"tsx"` (false positive — clsx is legitimate)
- 7 unused production deps: `@azure/openai`, `@hookform/resolvers`, `@mistralai/mistralai`, `@vercel/analytics`, `d3-dsv`, `endent`, `pdf-parse`
- 9 phantom imports flagged (all `@/` path aliases — false positives, these are Next.js path aliases)

## honest assessment

**worth opening an issue?** absolutely yes — chatbot-ui is the strongest case study.

**what's real and actionable:**
1. **217 unhandled async calls** — this is a genuine production safety issue. API calls, database operations, file operations all lack error boundaries. a single failed Supabase call can crash the UI with an unhandled promise rejection.
2. **22 duplicate function clusters** — the codebase has significant copy-paste debt. extracting shared utilities (e.g., a single `handleKeyDown` helper, a generic `createChatRoute` factory) would cut hundreds of lines.
3. **50 deprecated models** — users will encounter runtime errors trying to use sunset models.
4. **18 orphaned exports** — dead code that should be cleaned up.

**what's noise:**
- the typosquat warnings for `ai` and `clsx` are false positives
- the `@/` phantom import warnings are false positives (Next.js path aliases)
- some "thin file" warnings are legitimate small files (types, configs)

**verdict:** this is the best case study of the three. vet catches real, actionable issues in a TypeScript codebase. the unhandled async finding alone justifies running vet. the code duplication analysis is also genuinely useful. this would make a compelling "before/after" showcase for vet's README.
