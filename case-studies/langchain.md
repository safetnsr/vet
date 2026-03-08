# vet case study: langchain-ai/langchain

**repo:** https://github.com/langchain-ai/langchain
**description:** Build context-aware reasoning applications (massive Python monorepo)
**language:** Python (monorepo, 2800+ files)
**scanned:** 2026-03-08
**vet version:** v1.6.1

## overall score: 70/100 (grade C)

| category | score | weight |
|----------|-------|--------|
| security | 58/100 | 30% |
| integrity | 68/100 | 30% |
| debt | 67/100 | 25% |
| deps | 100/100 | 15% |

## version history

| version | score | grade | change |
|---------|-------|-------|--------|
| v1.5.0 | 70 | C | baseline |
| v1.6.0 | 70 | C | dist not rebuilt, no change |
| v1.6.1 | 70 | C | no score change |

## false positives status in v1.6.1

| finding | type | v1.6.0 | v1.6.1 |
|---------|------|--------|--------|
| `__init__.py` thin/empty flags | false positive | 311 found | **311 still present** |

the `__init__.py` thin file flags are **not fixed** for langchain. this massive monorepo has hundreds of legitimate empty `__init__.py` files (Python package markers). vet v1.6.1 fixed this for pydantic-ai's smaller set but langchain's sheer volume (311 `__init__.py` files) still triggers the verify check. this is a known limitation — future versions need Python-specific package structure awareness for monorepos.

## top findings (real issues)

### 1. 123 deprecated models referenced (severity: high)
multi-provider abstraction references `text-davinci-003`, `code-davinci-002`, older Claude versions. **real but inherent to the project.**

### 2. 221 findings across 34 config files (severity: high)
agent configs need tightening. **real.**

### 3. 6 stale facts in agent memory files (severity: medium)
outdated information in agent memory/config files. **real — unique to vet.**

### 4. 6 readiness issues (severity: medium)
large files hard for AI agents. **real.**

## verdict

the C grade is fair. langchain has legitimate config and memory issues. the biggest remaining noise source is the verify check flagging Python `__init__.py` files — 311 false positives that need Python monorepo awareness to fix properly.
