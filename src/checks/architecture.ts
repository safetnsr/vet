import { join, dirname, relative, sep } from 'node:path';
import { walkFiles, readFile, c } from '../util.js';
import type { CheckResult, Issue } from '../types.js';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']);

function isSourceFile(f: string): boolean {
  const dot = f.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTS.has(f.substring(dot));
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(f) || f.includes('__tests__') || /(?:^|[/\\])tests?[/\\]/.test(f);
}

// ── Import graph building ────────────────────────────────────────────────────

interface ImportEdge {
  from: string; // source file
  to: string;   // resolved target file
}

function resolveImport(fromFile: string, specifier: string, allFiles: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null; // only resolve relative imports
  const dir = dirname(fromFile);
  const base = join(dir, specifier).replace(/\\/g, '/');

  // Try exact, then with extensions, then as directory index
  const candidates = [
    base,
    ...Array.from(SOURCE_EXTS).map(ext => base + ext),
    ...Array.from(SOURCE_EXTS).map(ext => base + '/index' + ext),
  ];

  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return null;
}

function buildImportGraph(cwd: string, files: string[]): ImportEdge[] {
  const sourceFiles = files.filter(f => isSourceFile(f) && !isTestFile(f));
  const fileSet = new Set(sourceFiles);
  const edges: ImportEdge[] = [];

  const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

  for (const file of sourceFiles) {
    const content = readFile(join(cwd, file));
    if (!content) continue;

    let match: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith('.')) continue;

      const resolved = resolveImport(file, specifier, fileSet);
      if (resolved) {
        edges.push({ from: file, to: resolved });
      }
    }
  }

  return edges;
}

// ── Module detection ─────────────────────────────────────────────────────────

function getModule(file: string): string {
  // First directory under src/, lib/, app/, or root
  const parts = file.split(/[/\\]/);

  // Find the "source root" (src/, lib/, app/, packages/*)
  let start = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    if (['src', 'lib', 'app', 'source'].includes(parts[i])) {
      start = i + 1;
      break;
    }
  }

  if (start < parts.length - 1) {
    return parts.slice(0, start + 1).join('/');
  }
  // Fallback: use first directory
  return parts.length > 1 ? parts[0] : '(root)';
}

// ── Cycle detection (DFS) ────────────────────────────────────────────────────

function findCycles(moduleGraph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string) {
    if (inStack.has(node)) {
      // Found cycle — extract it
      const cycleStart = path.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push([...path.slice(cycleStart), node]);
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    const deps = moduleGraph.get(node);
    if (deps) {
      for (const dep of deps) {
        if (dep !== node) dfs(dep); // skip self-imports
      }
    }

    path.pop();
    inStack.delete(node);
  }

  for (const node of moduleGraph.keys()) {
    dfs(node);
  }

  // Deduplicate cycles (same cycle can be found from different start nodes)
  const seen = new Set<string>();
  return cycles.filter(cycle => {
    const sorted = [...cycle.slice(0, -1)].sort().join('|');
    if (seen.has(sorted)) return false;
    seen.add(sorted);
    return true;
  });
}

// ── Louvain community detection ──────────────────────────────────────────

interface LouvainResult {
  modularity: number;         // Q: -0.5 to 1.0 (higher = better modularity)
  communities: Map<string, number>; // node → community id
  communityCount: number;
}

function louvainCommunities(graph: Map<string, Set<string>>): LouvainResult {
  const nodes = Array.from(graph.keys());
  if (nodes.length < 2) {
    return { modularity: 0, communities: new Map(), communityCount: 0 };
  }

  // Build undirected weighted adjacency (edge count = weight)
  const adj = new Map<string, Map<string, number>>();
  for (const n of nodes) { adj.set(n, new Map()); }

  let totalEdges = 0;
  for (const [from, deps] of graph) {
    for (const to of deps) {
      if (!adj.has(to)) { adj.set(to, new Map()); }
      // Undirected: add both directions
      const w = (adj.get(from)!.get(to) || 0) + 1;
      adj.get(from)!.set(to, w);
      adj.get(to)!.set(from, w);
      totalEdges++;
    }
  }

  if (totalEdges === 0) {
    return { modularity: 0, communities: new Map(), communityCount: 0 };
  }

  const m = totalEdges; // total edge weight
  const m2 = 2 * m;

  // Degree of each node (sum of edge weights)
  const degree = new Map<string, number>();
  for (const [n, neighbors] of adj) {
    let d = 0;
    for (const w of neighbors.values()) d += w;
    degree.set(n, d);
  }

  // Initialize: each node in its own community
  const community = new Map<string, number>();
  nodes.forEach((n, i) => community.set(n, i));

  // Community totals: sum of degrees in each community
  const commDegree = new Map<number, number>();
  const commInternal = new Map<number, number>(); // sum of internal edges × 2
  for (const [n, c] of community) {
    commDegree.set(c, degree.get(n) || 0);
    commInternal.set(c, 0);
  }

  // Iterative optimization (1 pass — good enough for code graphs)
  let moved = true;
  let iterations = 0;
  while (moved && iterations < 10) {
    moved = false;
    iterations++;

    for (const node of nodes) {
      const nodeDeg = degree.get(node) || 0;
      const currentComm = community.get(node)!;

      // Calculate edges to each neighboring community
      const commEdges = new Map<number, number>();
      const neighbors = adj.get(node) || new Map();
      for (const [neighbor, weight] of neighbors) {
        const nc = community.get(neighbor);
        if (nc !== undefined) {
          commEdges.set(nc, (commEdges.get(nc) || 0) + weight);
        }
      }

      // Modularity gain for moving node to community c:
      // ΔQ = [Σin + 2*ki,in] / 2m - [(Σtot + ki) / 2m]² - [Σin/2m - (Σtot/2m)² - (ki/2m)²]
      let bestComm = currentComm;
      let bestGain = 0;

      // Remove node from current community
      const edgesToCurrent = commEdges.get(currentComm) || 0;

      for (const [targetComm, edgesToTarget] of commEdges) {
        if (targetComm === currentComm) continue;

        const sigmaTot = commDegree.get(targetComm) || 0;
        const sigmaIn = commInternal.get(targetComm) || 0;

        // Simplified modularity gain
        const gain = (edgesToTarget / m) - (sigmaTot * nodeDeg) / (m2 * m);

        if (gain > bestGain) {
          bestGain = gain;
          bestComm = targetComm;
        }
      }

      if (bestComm !== currentComm) {
        // Move node
        commDegree.set(currentComm, (commDegree.get(currentComm) || 0) - nodeDeg);
        commInternal.set(currentComm, (commInternal.get(currentComm) || 0) - 2 * edgesToCurrent);

        commDegree.set(bestComm, (commDegree.get(bestComm) || 0) + nodeDeg);
        const edgesToBest = commEdges.get(bestComm) || 0;
        commInternal.set(bestComm, (commInternal.get(bestComm) || 0) + 2 * edgesToBest);

        community.set(node, bestComm);
        moved = true;
      }
    }
  }

  // Calculate final modularity Q
  let Q = 0;
  for (const [n1, neighbors] of adj) {
    for (const [n2, w] of neighbors) {
      if (community.get(n1) === community.get(n2)) {
        const d1 = degree.get(n1) || 0;
        const d2 = degree.get(n2) || 0;
        Q += w - (d1 * d2) / m2;
      }
    }
  }
  Q /= m2;

  // Count unique communities
  const uniqueComms = new Set(community.values());

  return { modularity: Q, communities: community, communityCount: uniqueComms.size };
}

// ── Main check ───────────────────────────────────────────────────────────────

export function checkArchitecture(cwd: string): CheckResult {
  const allFiles = walkFiles(cwd);
  const sourceFiles = allFiles.filter(f => isSourceFile(f) && !isTestFile(f));

  if (sourceFiles.length < 5) {
    return {
      maxScore: 100,
      name: 'architecture',
      score: 100,
      summary: 'too few source files for architecture analysis',
      issues: [],
    };
  }

  const edges = buildImportGraph(cwd, allFiles);
  const issues: Issue[] = [];

  // ── Build module-level graph ───────────────────────────────────────────────
  const moduleGraph = new Map<string, Set<string>>(); // module → set of imported modules
  const moduleFiles = new Map<string, Set<string>>();  // module → files in it

  for (const file of sourceFiles) {
    const mod = getModule(file);
    if (!moduleFiles.has(mod)) moduleFiles.set(mod, new Set());
    moduleFiles.get(mod)!.add(file);
    if (!moduleGraph.has(mod)) moduleGraph.set(mod, new Set());
  }

  for (const edge of edges) {
    const fromMod = getModule(edge.from);
    const toMod = getModule(edge.to);
    if (fromMod !== toMod) {
      moduleGraph.get(fromMod)?.add(toMod);
    }
  }

  // ── Coupling metrics ──────────────────────────────────────────────────────
  const afferent = new Map<string, number>();  // Ca: who depends on me
  const efferent = new Map<string, number>();  // Ce: who do I depend on

  for (const [mod, deps] of moduleGraph) {
    efferent.set(mod, deps.size);
    for (const dep of deps) {
      afferent.set(dep, (afferent.get(dep) || 0) + 1);
    }
  }

  // Instability: Ce / (Ca + Ce). 0 = stable (many dependents), 1 = unstable
  const instability = new Map<string, number>();
  for (const mod of moduleGraph.keys()) {
    const ca = afferent.get(mod) || 0;
    const ce = efferent.get(mod) || 0;
    instability.set(mod, ca + ce > 0 ? ce / (ca + ce) : 0.5);
  }

  // ── God files ──────────────────────────────────────────────────────────────
  const fileImporters = new Map<string, Set<string>>(); // file → files that import it
  for (const edge of edges) {
    if (!fileImporters.has(edge.to)) fileImporters.set(edge.to, new Set());
    fileImporters.get(edge.to)!.add(edge.from);
  }

  const GOD_FILE_THRESHOLD = 10;
  const godFiles: { file: string; importers: number }[] = [];
  for (const [file, importers] of fileImporters) {
    if (importers.size >= GOD_FILE_THRESHOLD) {
      godFiles.push({ file, importers: importers.size });
    }
  }
  godFiles.sort((a, b) => b.importers - a.importers);

  for (const gf of godFiles) {
    issues.push({
      severity: 'warning',
      message: `god file: ${gf.file} is imported by ${gf.importers} files — consider splitting by domain`,
      file: gf.file,
      fixable: true,
      fixHint: 'split into smaller, domain-specific modules',
    });
  }

  // ── Circular dependencies ─────────────────────────────────────────────────
  const cycles = findCycles(moduleGraph);
  for (const cycle of cycles.slice(0, 5)) { // cap at 5 reported cycles
    const cycleStr = cycle.join(' → ');
    issues.push({
      severity: 'warning',
      message: `circular dependency: ${cycleStr}`,
      file: cycle[0],
      fixable: true,
      fixHint: 'extract shared types/interfaces into a separate module to break the cycle',
    });
  }

  // ── Unstable modules with high dependents (worst pattern) ──────────────────
  for (const [mod, inst] of instability) {
    const ca = afferent.get(mod) || 0;
    if (inst > 0.8 && ca >= 3) {
      issues.push({
        severity: 'warning',
        message: `unstable dependency: ${mod} has instability ${inst.toFixed(2)} but ${ca} modules depend on it — changes here break downstream`,
        file: mod,
        fixable: true,
        fixHint: 'reduce dependencies or add an abstraction layer',
      });
    }
  }

  // ── Orphan modules ────────────────────────────────────────────────────────
  for (const mod of moduleGraph.keys()) {
    const ca = afferent.get(mod) || 0;
    const ce = efferent.get(mod) || 0;
    const files = moduleFiles.get(mod);
    if (ca === 0 && ce === 0 && files && files.size > 2) {
      // Skip entry point modules
      const hasEntry = Array.from(files).some(f => /(?:^|[/\\])(?:index|main|cli|app|server)\.[jt]sx?$/.test(f));
      if (!hasEntry) {
        issues.push({
          severity: 'info',
          message: `orphan module: ${mod} (${files.size} files) is not imported by any other module`,
          file: mod,
          fixable: false,
          fixHint: 'may be dead code — verify if still needed',
        });
      }
    }
  }

  // ── Boundary violations ───────────────────────────────────────────────────
  // Files importing deep into another module (>2 levels) instead of from its index
  let boundaryViolations = 0;
  for (const edge of edges) {
    const fromMod = getModule(edge.from);
    const toMod = getModule(edge.to);
    if (fromMod === toMod) continue;

    // Check if target file is deep inside the module (not the index)
    const toRelative = edge.to.replace(toMod + '/', '');
    if (toRelative.includes('/') && !/^index\.[jt]sx?$/.test(toRelative)) {
      boundaryViolations++;
      if (boundaryViolations <= 3) { // only report first 3
        issues.push({
          severity: 'info',
          message: `boundary violation: ${edge.from} imports ${edge.to} directly — prefer importing from ${toMod}/index`,
          file: edge.from,
          fixable: true,
          fixHint: `re-export from ${toMod}/index.ts and import from there`,
        });
      }
    }
  }
  if (boundaryViolations > 3) {
    issues.push({
      severity: 'info',
      message: `${boundaryViolations - 3} more boundary violations (importing deep into other modules)`,
      file: '',
      fixable: false,
      fixHint: 'use barrel exports (index.ts) to define module boundaries',
    });
  }

  // ── Louvain modularity ─────────────────────────────────────────────────
  const louvain = louvainCommunities(moduleGraph);

  if (moduleGraph.size >= 3) {
    if (louvain.modularity < 0.3 && louvain.communityCount > 1) {
      issues.push({
        severity: 'warning',
        message: `low modularity: Q=${louvain.modularity.toFixed(2)} (${louvain.communityCount} communities detected) — modules are too interconnected`,
        file: '',
        fixable: true,
        fixHint: 'reduce cross-module dependencies, group related files into cohesive modules',
      });
    } else if (louvain.communityCount <= 1 && moduleGraph.size > 5) {
      issues.push({
        severity: 'info',
        message: `monolithic structure: all ${moduleGraph.size} modules form a single community — no clear architectural boundaries`,
        file: '',
        fixable: true,
        fixHint: 'introduce module boundaries with clear interfaces (barrel exports)',
      });
    }
  }

  // ── Scoring ───────────────────────────────────────────────────────────────
  const moduleCount = moduleGraph.size;
  const sizeScale = moduleCount <= 5 ? 1.0 : Math.max(0.3, 1.0 - Math.log10(moduleCount / 5) * 0.3);

  let score = 100;
  score -= Math.min(30, cycles.length * 15) * sizeScale;
  score -= Math.min(20, godFiles.length * 10) * sizeScale;
  score -= Math.min(15, Array.from(instability.values()).filter(i => i > 0.8).length * 5) * sizeScale;
  score -= Math.min(10, Math.floor(boundaryViolations / 3) * 3) * sizeScale;
  // Modularity penalty: low Q on non-trivial graphs
  if (moduleGraph.size >= 5 && louvain.modularity < 0.3) {
    score -= Math.min(15, Math.round((0.3 - louvain.modularity) * 50));
  }
  score = Math.max(25, Math.round(score));

  // ── Summary ───────────────────────────────────────────────────────────────
  const parts: string[] = [];
  parts.push(`${moduleGraph.size} modules`);
  parts.push(`${edges.length} edges`);
  if (louvain.communityCount > 0) parts.push(`Q=${louvain.modularity.toFixed(2)} (${louvain.communityCount} communities)`);
  if (cycles.length > 0) parts.push(c.red + `${cycles.length} circular dep${cycles.length !== 1 ? 's' : ''}` + c.reset);
  if (godFiles.length > 0) parts.push(c.yellow + `${godFiles.length} god file${godFiles.length !== 1 ? 's' : ''}` + c.reset);

  return {
      maxScore: 100,
    name: 'architecture',
    score,
    summary: parts.join(', '),
    issues,
  };
}
