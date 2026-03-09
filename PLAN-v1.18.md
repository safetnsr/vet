# Plan: Architecture + AI-Readiness checks (v1.18.0)

## Why these are NOT linter checks

Linters work per-file, per-line. These work across the entire project graph.
No linter can tell you "your api module has instability 0.89" or "an agent needs 4.2 files of context to modify one module."

## Architecture check (`src/checks/architecture.ts`)

### Data: import graph
- Reuse existing import parsing (deps.ts pattern)
- Build adjacency list: file → [resolved imported files]
- Aggregate to module level (directory = module)

### Metrics

| metric | what it measures | how |
|---|---|---|
| afferent coupling (Ca) | who depends on me | count incoming imports per module |
| efferent coupling (Ce) | who do I depend on | count outgoing imports per module |
| instability (I) | Ce / (Ca + Ce) | 0 = stable (many dependents), 1 = unstable (many dependencies) |
| circular deps | cycles in the graph | DFS with back-edge detection |
| god files | files imported by >N others | threshold: 10+ importers |
| orphan modules | dirs never imported | 0 incoming edges |
| boundary violations | internal files imported directly | imports like `../../auth/internal/hash` instead of `../../auth` |

### Output
```
🏗 Architecture     B (78)

  src/db/         Ca:6  Ce:1  I:0.14 ✓ stable foundation
  src/auth/       Ca:3  Ce:2  I:0.40   balanced
  src/api/        Ca:1  Ce:8  I:0.89 ⚠ unstable — depends on everything
  src/utils/      Ca:12 Ce:0  I:0.00 ✓ pure utility

  ⚠ circular: api/ → auth/ → db/ → api/
  ⚠ god file: utils/helpers.ts (23 importers) — split by domain
  ⚠ boundary: 4 files import auth/internal/* directly
```

### Scoring
- Start at 100
- -15 per circular dependency cycle
- -10 per god file (>10 importers)
- -5 per module with instability >0.8 AND high Ca (unstable but depended upon = worst)
- -3 per boundary violation
- -2 per orphan module
- Floor: 25, size-normalized

### Issues (fixable)
- Circular deps: "break cycle by extracting shared types to a separate module"
- God files: "split utils/helpers.ts into domain-specific utility files"
- Boundary violations: "import from auth/ index, not auth/internal/hash"

---

## AI-Readiness check (`src/checks/aiready.ts`)

### Why this is novel
No tool measures "how well can an AI agent work with this codebase."
This is the check that makes vet unique in the AI era.

### Metrics

| metric | what it measures | how | weight |
|---|---|---|---|
| context load | files needed to understand 1 module | avg imports per file + transitive deps | 25% |
| function clarity | % functions an agent can modify safely | functions <25 lines AND typed | 20% |
| type safety | can agent verify its changes? | TS file ratio × (1 - any_density) | 20% |
| file discoverability | can agent find the right file? | naming consistency + max depth ≤4 + predictable structure | 15% |
| modification safety | can agent change code without breaking things? | % functions with both types AND test coverage | 10% |
| context window fit | how much codebase fits in one shot? | total source tokens vs 128k | 10% |

### context load (novel metric)
```typescript
// For each file, count how many other files you need to load to understand it
// Direct imports + 1 level of transitive imports
function contextLoad(file: string, graph: Map<string, string[]>): number {
  const direct = graph.get(file) || [];
  const transitive = new Set<string>();
  for (const d of direct) {
    transitive.add(d);
    for (const t of graph.get(d) || []) transitive.add(t);
  }
  return transitive.size;
}
// Average across all files = project context load
// Low (1-3) = agent-friendly, High (8+) = agent-hostile
```

### function clarity
```typescript
// Parse all functions, measure:
// - line count (<25 = clear, 25-50 = okay, >50 = unclear)  
// - parameter count (<4 = clear, ≥4 = complex)
// - has return type annotation (typed = safer for agents)
// Score = % of functions that are "clear" (short + few params + typed)
```

### file discoverability
```typescript
// Heuristic scoring:
// - consistent naming convention (camelCase vs kebab-case vs mixed) → penalty for mixed
// - max directory depth ≤4 → penalty per level above 4
// - avg files per directory 3-15 → penalty for >20 (hard to scan) or <2 (over-nested)
// - predictable patterns: components/, hooks/, utils/, lib/, api/ → bonus
```

### context window fit
```typescript
// Estimate total tokens: sum of all source file sizes / 4 (rough token estimate)
// Score based on what % fits in 128k context:
// - 100% fits → score 100
// - 50% fits → score 70
// - 25% fits → score 40
// - <10% fits → score 20
```

### Output
```
🤖 AI-Readiness    C (65)

  context load:       4.2 files avg (target: <3)
  function clarity:   78% clear (89 of 114 functions)
  type safety:        64% (34% JS files, 12 `any` usages)
  file discoverability: A (flat, consistent kebab-case)
  modification safety: 45% (many untyped + untested functions)
  context window fit: 92% fits in 128k

  Biggest barriers for AI agents:
    ⚠ 12 functions >50 lines — agents will hallucinate modifications
    ⚠ src/legacy/ has 0% type coverage — agents can't verify changes
    ⚠ circular deps force agents to load 3x more context
```

---

## Integration

### New categories
Current: security, integrity, debt, deps (4 categories)
New: security, integrity, debt, deps, architecture, aiready (6 categories)

### Weight distribution
- security: 25% (unchanged)
- integrity: 20% (was 25%)
- debt: 15% (was 25%)  
- deps: 15% (was 25%)
- architecture: 15% (NEW)
- aiready: 10% (NEW)

### Calibration impact
- Must re-run calibration after adding new checks
- Target: maintain >0.90 correlation
- New checks start with conservative scoring (floor 40 instead of 25)

### Implementation order
1. `architecture.ts` — graph building + metrics + scoring + issues
2. `aiready.ts` — all heuristic metrics + scoring
3. Update `categories.ts` with new weights
4. Rebuild + run calibration
5. Adjust weights/thresholds based on correlation
6. v1.18.0 publish

### No external dependencies needed
- Import graph: regex-based (existing pattern)
- Function analysis: regex-based (existing pattern)
- Cycle detection: DFS (trivial algorithm)
- Token estimation: character count / 4
- All pure TypeScript, zero new deps

### Future: --deep mode (v2)
- tree-sitter for accurate AST (function boundaries, nesting depth)
- ONNX classifier for "is this function name descriptive?"
- Actual test coverage parsing (lcov/istanbul reports)
- Git blame analysis for modification frequency
