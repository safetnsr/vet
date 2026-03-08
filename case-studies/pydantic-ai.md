# vet case study: pydantic/pydantic-ai

**repo:** https://github.com/pydantic/pydantic-ai
**description:** Agent Framework / shim to use Pydantic with LLMs
**language:** Python (71k+ lines)
**scanned:** 2026-03-08
**vet version:** v1.7.0

## overall score: 82/100 (grade A)

| category | score | weight |
|----------|-------|--------|
| security | 76/100 | 30% |
| integrity | 82/100 | 30% |
| debt | 80/100 | 25% |
| deps | 100/100 | 15% |

## version history

| version | score | grade | change |
|---------|-------|-------|--------|
| v1.5.0 | 76 | B | baseline |
| v1.6.0 | 76 | B | dist not rebuilt, no change |
| v1.6.1 | 76 | B | no change — no affected false positives |
| v1.7.0 | 82 | A | security +17, integrity +4, +6 points overall |

## v1.7.0 changes

biggest jump of all three case studies. security went from 59 to 76 (+17), a major improvement from v1.7.0's refined config and model-graveyard scoring. integrity up from 78 to 82. debt stayed at 80. the B → A grade reflects pydantic-ai's genuinely clean codebase getting fairer treatment.

## top findings (real issues)

### 1. deprecated models referenced (severity: high)
model-graveyard check finds references across multi-provider framework. **real but context-dependent.**

### 2. config findings (severity: high)
agent config files with permissive defaults. **real.**

### 3. unhandled async operations (severity: medium)
low count for a project this size. **real.**

### 4. large files flagged for readiness (severity: low)
files over 500 lines. **real but minor.**

## verdict

the B → A grade in v1.7.0 is deserved. pydantic-ai is well-structured, has good test coverage, and the security score increase reflects v1.7.0's better understanding of Python project patterns. this is the cleanest of the three case study repos.
