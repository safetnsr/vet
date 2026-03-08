# vet case study: langchain-ai/langchain

**repo:** https://github.com/langchain-ai/langchain
**description:** Build context-aware reasoning applications (massive Python monorepo)
**language:** Python (monorepo, 2800+ files)
**scanned:** 2026-03-08

## overall score: 70/100 (grade C)

| category | score | weight |
|----------|-------|--------|
| security | 58/100 | 30% |
| integrity | 68/100 | 30% |
| debt | 67/100 | 25% |
| deps | 100/100 | 15% |

## top 5 findings

### 1. 123 deprecated models referenced (severity: high)
langchain references 123 deprecated/sunset model identifiers. given langchain's role as a multi-provider abstraction layer, this is expected but significant. models like `text-davinci-003`, `code-davinci-002`, and older Claude versions are still referenced.

### 2. 6 stale facts in agent memory files (severity: medium)
vet found stale information in agent memory/config files. this means if an AI agent works on this repo using these configs, it might operate on outdated assumptions.

### 3. 221 findings across 34 config files (severity: high)
the security scanner found issues in agent configs — Claude Code and OpenAI Codex configs scored 70/100. the configs exist but need tightening.

### 4. 774 claims failed verification (severity: medium)
many files flagged as "thin" — again, Python project structure creates false positives with small `__init__.py`, type stubs, and config files. 2060 claims did pass though.

### 5. 6 readiness issues — very large files (severity: medium)
some files exceed the recommended line count for AI comprehension. in a monorepo this large, that's not surprising but worth noting.

### bonus: 2 OWASP findings
vet detected 2 OWASP-aligned issues in agent configs (ASI01-ASI10 framework). these relate to how agents are configured to interact with the codebase.

## honest assessment

**worth opening an issue?** the deprecated models finding is genuinely interesting for langchain.

langchain is a provider abstraction layer, so having deprecated model references is partly by design — but some of these models are fully sunset and will fail at runtime. a cleanup PR removing references to dead models (text-davinci-003, code-davinci-002, etc.) would be welcome.

the stale agent memory finding is also interesting — it means langchain's own AI development configs contain outdated information.

the main noise: vet's verify check doesn't understand Python project structure well. the "phantom import" and "thin file" findings are largely false positives.

**verdict:** the deprecated models finding is worth a focused cleanup PR. the stale memory finding is worth mentioning. the rest is noise from applying a JS-focused tool to Python.
