# vet case study: pydantic/pydantic-ai

**repo:** https://github.com/pydantic/pydantic-ai
**description:** Agent Framework / shim to use Pydantic with LLMs
**language:** Python (71k+ lines)
**scanned:** 2026-03-08
**vet version:** v1.6.1

## overall score: 76/100 (grade B)

| category | score | weight |
|----------|-------|--------|
| security | 59/100 | 30% |
| integrity | 78/100 | 30% |
| debt | 80/100 | 25% |
| deps | 100/100 | 15% |

## version history

| version | score | grade | change |
|---------|-------|-------|--------|
| v1.5.0 | 76 | B | baseline |
| v1.6.0 | 76 | B | dist not rebuilt, no change |
| v1.6.1 | 76 | B | no change — this repo had no affected false positives |

## false positives fixed in v1.6.1

| finding | type | v1.6.0 | v1.6.1 |
|---------|------|--------|--------|
| `__init__.py` thin file flags | false positive | present | **gone** |
| `.pyi` thin file flags | false positive | present | **gone** |

the thin file flags on Python `__init__.py` and `.pyi` files are eliminated. this doesn't change the overall score because the verify check's weight is diluted by the large number of passing claims, but it removes noise from the findings list.

## top findings (real issues)

### 1. 167 deprecated models referenced (severity: high)
model-graveyard check found 167 references. expected for a multi-provider AI framework. **real but context-dependent.**

### 2. 166 findings in 20 config files (severity: high)
agent config files with permissive defaults. **real.**

### 3. 13 unhandled async operations (severity: medium)
low count for a project this size. **real.**

### 4. 4 large files flagged for readiness (severity: low)
files over 500 lines. **real but minor.**

## verdict

score unchanged at 76/B. pydantic-ai is a well-structured project. the main improvement is reduced noise in the findings — `__init__.py` and `.pyi` files no longer incorrectly flagged as thin/empty.
