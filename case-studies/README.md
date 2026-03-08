# vet case studies

real-world scans of popular AI repos using `@safetnsr/vet`.

## summary table

| repo | language | files | v1.5 score | v1.6.0 score | v1.6.1 score | grade | change |
|------|----------|-------|------------|--------------|--------------|-------|--------|
| [chatbot-ui](chatbot-ui.md) | TypeScript | 258 files | 56 | 56 | **71** | D → C | **+15** |
| [pydantic-ai](pydantic-ai.md) | Python | 71k+ lines | 76 | 76 | **76** | B | none |
| [langchain](langchain.md) | Python | 2800+ files | 70 | 70 | **70** | C | none |

## v1.6.1: what changed

v1.6.0 committed fixes to source but **did not rebuild dist** before publishing. v1.6.1 includes the actual compiled fixes.

### false positive fixes verified

| false positive | repo | v1.6.0 | v1.6.1 | impact |
|----------------|------|--------|--------|--------|
| `@/` path aliases as phantom imports (9x) | chatbot-ui | present | **gone** | deps 0 → 100 |
| `"ai"` typosquat of `"joi"` | chatbot-ui | present | **gone** | deps 0 → 100 |
| `"clsx"` typosquat of `"tsx"` | chatbot-ui | present | **gone** | deps 0 → 100 |
| `__init__.py` thin file flags | pydantic-ai | present | **gone** | reduced noise |
| `.pyi` thin file flags | pydantic-ai | present | **gone** | reduced noise |
| `__init__.py` thin file flags | langchain | 311 found | **311 still present** | not fixed yet |

### remaining known issues

- langchain's 311 `__init__.py` false positives need Python monorepo-specific heuristics
- verify check still noisy for Python project structures with many small legitimate files

### what's real vs false positive

| finding type | count across repos | verdict |
|-------------|-------------------|---------|
| deprecated models | 340 total | real, expected for AI frameworks |
| agent config issues | 387 findings | real — configs need tightening |
| unhandled async | 230 total | real — production quality concern |
| code duplication | 22 clusters | real — tech debt |
| orphaned exports | 18 | real — dead code |
| thin file verification | still noisy for Python | improving, not fully solved |
| deps typosquat/phantom | 0 (was 11) | **fixed in v1.6.1** |

## repo details

- **[chatbot-ui](chatbot-ui.md)** — grade C (was D), biggest improvement from false positive fixes
- **[pydantic-ai](pydantic-ai.md)** — grade B, stable, reduced noise in findings
- **[langchain](langchain.md)** — grade C, legitimate config/memory issues, verify still noisy for Python monorepos
