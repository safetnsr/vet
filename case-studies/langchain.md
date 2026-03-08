# vet case study: langchain-ai/langchain

**repo:** https://github.com/langchain-ai/langchain
**description:** Build context-aware reasoning applications (massive Python monorepo)
**language:** Python (monorepo, 2800+ files)
**scanned:** 2026-03-08
**vet version:** v1.7.0

## overall score: 74/100 (grade B)

| category | score | weight |
|----------|-------|--------|
| security | 62/100 | 30% |
| integrity | 73/100 | 30% |
| debt | 73/100 | 25% |
| deps | 100/100 | 15% |

## version history

| version | score | grade | change |
|---------|-------|-------|--------|
| v1.5.0 | 70 | C | baseline |
| v1.6.0 | 70 | C | dist not rebuilt, no change |
| v1.6.1 | 70 | C | no score change |
| v1.7.0 | 74 | B | security +4, integrity +5, debt +6, +4 points overall |

## v1.7.0 changes

score improved from 70 (C) to 74 (B). all categories improved: security 58 → 62 (+4), integrity 68 → 73 (+5), debt 67 → 73 (+6). the verify check still flags many `__init__.py` files as thin/empty, but v1.7.0's scoring better accounts for Python monorepo patterns, reducing their impact on the overall score.

## top findings (real issues)

### 1. deprecated models referenced (severity: high)
multi-provider abstraction references `text-davinci-003`, `code-davinci-002`, older Claude versions. **real but inherent to the project.**

### 2. config findings across 34 config files (severity: high)
agent configs need tightening. **real.**

### 3. broken path references in CLAUDE.md/AGENTS.md (severity: medium)
references to `../langchain-google/`, `../docs/` that don't resolve. **real.**

### 4. 524 verify claims failed (severity: medium)
mostly empty `__init__.py` files — legitimate Python package markers but flagged by verify. **partially false positive for monorepo pattern.**

## verdict

the C → B grade in v1.7.0 reflects better calibration across all categories. langchain is a massive monorepo and the score improvement shows v1.7.0 handling Python patterns with less noise. the verify check's `__init__.py` false positives remain but their impact is reduced.
