# vet case study: pydantic/pydantic-ai

**repo:** https://github.com/pydantic/pydantic-ai
**description:** Agent Framework / shim to use Pydantic with LLMs
**language:** Python (71k+ lines)
**scanned:** 2026-03-08

## overall score: 76/100 (grade B)

| category | score | weight |
|----------|-------|--------|
| security | 59/100 | 30% |
| integrity | 78/100 | 30% |
| debt | 80/100 | 25% |
| deps | 100/100 | 15% |

## top 5 findings

### 1. 167 deprecated models referenced (severity: high)
The model-graveyard check found 167 references to deprecated/sunset models across the codebase. For an AI framework, this is expected — they support many providers — but it's still a lot of dead model strings in code and docs.

### 2. 166 findings in 20 config files (severity: high)
The security scanner flagged 166 issues across agent config files. These are mostly about how Claude Code and OpenAI Codex configs are set up — permissive defaults, missing constraints.

### 3. 695 claims failed verification (severity: medium)
The verify check found many "thin files" — files that exist but have minimal content. This is partly because pydantic-ai has a lot of small Python modules (type stubs, __init__.py, etc.), which is normal for Python projects but vet flags them.

### 4. 13 unhandled async operations (severity: medium)
Some await calls without proper try/catch error handling. Not catastrophic but shows areas where errors could silently fail.

### 5. 4 readiness issues — large files (severity: low)
Some files are over 500 lines, making them harder for AI agents to work with effectively.

## honest assessment

**worth opening an issue?** partially.

the deprecated models finding is genuinely useful — pydantic-ai could benefit from auditing which model strings they reference. but many of these are intentional (they support legacy providers). the config findings are mostly about agent safety configs being permissive, which is a design choice.

the biggest false-positive problem: vet's verify check flags python `__init__.py` and type stub files as "thin files" — that's a known limitation of running a JS/TS-focused tool on a Python codebase. vet works but the signal-to-noise ratio drops on non-JS projects.

**verdict:** interesting data but not issue-worthy. the deprecated models finding is the most actionable.
