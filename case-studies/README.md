# vet case studies

real-world scans of popular AI repos using `@safetnsr/vet`.

## summary table

| repo | language | files | v1.5 | v1.6.1 | v1.7.0 | grade | trend |
|------|----------|-------|------|--------|--------|-------|-------|
| [chatbot-ui](chatbot-ui.md) | TypeScript | 258 | 56 | 71 | **75** | D → C → B | ↑ +19 |
| [pydantic-ai](pydantic-ai.md) | Python | 71k+ lines | 76 | 76 | **82** | B → B → A | ↑ +6 |
| [langchain](langchain.md) | Python | 2800+ files | 70 | 70 | **74** | C → C → B | ↑ +4 |

## v1.7.0: what changed

v1.7.0 brings scoring improvements across all categories. key changes:

- **security scoring recalibrated** — better weighting of config findings, reduced false positive impact
- **integrity scoring improved** — verify check less punishing for Python package patterns
- **debt scoring refined** — readiness checks better calibrated for large repos

### score progression

| repo | v1.5 → v1.6.1 | v1.6.1 → v1.7.0 | total change |
|------|----------------|------------------|--------------|
| chatbot-ui | +15 (false positive fixes) | +4 (scoring calibration) | **+19** |
| pydantic-ai | 0 | +6 (security recalibration) | **+6** |
| langchain | 0 | +4 (all categories improved) | **+4** |

### category breakdown v1.7.0

| repo | security | integrity | debt | deps |
|------|----------|-----------|------|------|
| chatbot-ui | 73 | 82 | 53 | 100 |
| pydantic-ai | 76 | 82 | 80 | 100 |
| langchain | 62 | 73 | 73 | 100 |

### what's real vs false positive

| finding type | count across repos | verdict |
|-------------|-------------------|---------|
| deprecated models | 340+ total | real, expected for AI frameworks |
| agent config issues | 387+ findings | real — configs need tightening |
| unhandled async | 230+ total | real — production quality concern |
| code duplication | 22 clusters | real — tech debt |
| orphaned exports | 18 | real — dead code |
| thin file verification | reduced impact in v1.7.0 | improving, Python patterns better handled |
| deps typosquat/phantom | 0 (fixed in v1.6.1) | **fixed** |

## repo details

- **[chatbot-ui](chatbot-ui.md)** — grade B (was D → C), steady improvement across versions
- **[pydantic-ai](pydantic-ai.md)** — grade A (was B), cleanest repo, biggest v1.7.0 benefit
- **[langchain](langchain.md)** — grade B (was C), massive monorepo with legitimate complexity
