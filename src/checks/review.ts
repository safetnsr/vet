import { join, relative } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { readFile, c } from '../util.js'
import type { CheckResult, Issue } from '../types.js'

// ── Section definitions ──────────────────────────────────────────────────────

interface Section {
  name: string
  points: number
  patterns: RegExp[]
  missingImpact: string
}

const SECTIONS: Section[] = [
  {
    name: 'FOCUS AREAS',
    points: 20,
    patterns: [/focus/i, /priority/i, /look for/i, /check for/i, /pay attention/i, /concentrate on/i],
    missingImpact: 'Claude Code Review will leave generic comments',
  },
  {
    name: 'OUT-OF-SCOPE',
    points: 20,
    patterns: [/out of scope/i, /out-of-scope/i, /ignore/i, /skip/i, /don't review/i, /exclude/i, /not relevant/i],
    missingImpact: 'Reviews may flag irrelevant code patterns',
  },
  {
    name: 'PERSONA',
    points: 20,
    patterns: [/act as/i, /you are/i, /persona/i, /role/i, /reviewer/i, /behave as/i],
    missingImpact: 'Reviewer has no defined expertise or tone',
  },
  {
    name: 'TOOL LIST',
    points: 20,
    patterns: [/tools/i, /allowed tools/i, /disallowed/i, /permitted/i, /use the following/i],
    missingImpact: 'No tool restrictions — agent may use unexpected tools',
  },
  {
    name: 'EXAMPLES',
    points: 20,
    patterns: [], // special: checks for fenced code blocks
    missingImpact: 'No example review comments — output style unpredictable',
  },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

function findReviewFiles(dir: string, maxDepth: number): string[] {
  const results: string[] = []

  function walk(d: string, depth: number) {
    if (depth > maxDepth) return
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue
      const full = join(d, entry)
      try {
        const stat = statSync(full)
        if (stat.isFile() && entry === 'REVIEW.md') {
          results.push(full)
        } else if (stat.isDirectory()) {
          walk(full, depth + 1)
        }
      } catch { /* skip */ }
    }
  }

  walk(dir, 0)
  return results
}

interface SectionResult {
  name: string
  passed: boolean
  points: number
  missingImpact: string
}

function scoreFile(content: string): { score: number; sections: SectionResult[] } {
  const sections: SectionResult[] = []

  for (const section of SECTIONS) {
    let passed = false

    if (section.name === 'EXAMPLES') {
      // Check for fenced code blocks
      passed = /```/.test(content)
    } else {
      passed = section.patterns.some(re => re.test(content))
    }

    sections.push({
      name: section.name,
      passed,
      points: section.points,
      missingImpact: section.missingImpact,
    })
  }

  const score = sections.reduce((sum, s) => sum + (s.passed ? s.points : 0), 0)
  return { score, sections }
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkReview(cwd: string): Promise<CheckResult> {
  const files = findReviewFiles(cwd, 3)
  const issues: Issue[] = []

  if (files.length === 0) {
    return {
      name: 'review',
      score: 0,
      maxScore: 100,
      issues: [{
        severity: 'info',
        message: 'No REVIEW.md found — create one to enable Claude Code Review',
        fixable: false,
      }],
      summary: 'no REVIEW.md found',
    }
  }

  let totalScore = 0

  for (const file of files) {
    const content = readFile(file) || ''
    const result = scoreFile(content)
    totalScore += result.score
    const rel = relative(cwd, file)

    if (result.score === 0) {
      issues.push({
        severity: 'warning',
        message: `${rel}: score 0/100 — no behavioral sections detected`,
        file: rel,
        fixable: false,
      })
    } else if (result.score < 100) {
      const missing = result.sections.filter(s => !s.passed).map(s => s.name)
      issues.push({
        severity: 'warning',
        message: `${rel}: score ${result.score}/100 — missing: ${missing.join(', ')}`,
        file: rel,
        fixable: false,
      })
    }
  }

  const avgScore = Math.round(totalScore / files.length)

  const summary = files.length === 1
    ? `REVIEW.md score ${avgScore}/100`
    : `${files.length} REVIEW.md files — average score ${avgScore}/100`

  return {
    name: 'review',
    score: avgScore,
    maxScore: 100,
    issues,
    summary,
  }
}

// ── Subcommand output ────────────────────────────────────────────────────────

export async function runReviewCommand(cwd: string, format: string): Promise<void> {
  const files = findReviewFiles(cwd, 3)

  if (format === 'json') {
    const results = files.map(file => {
      const content = readFile(file) || ''
      const result = scoreFile(content)
      return { file: relative(cwd, file), score: result.score, sections: result.sections }
    })
    console.log(JSON.stringify({
      files: results,
      score: files.length > 0 ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length) : 0,
    }, null, 2))
    return
  }

  console.log(`\n  ${c.bold}vet review${c.reset} — REVIEW.md behavioral completeness\n`)

  if (files.length === 0) {
    console.log(`  ${c.dim}no REVIEW.md found${c.reset}`)
    console.log(`  ${c.dim}create one to guide Claude Code Review behavior${c.reset}\n`)
    return
  }

  for (const file of files) {
    const content = readFile(file) || ''
    const result = scoreFile(content)
    const rel = relative(cwd, file)

    console.log(`  ${c.bold}${rel}${c.reset}`)
    console.log(`  ${c.dim}${'─'.repeat(50)}${c.reset}`)

    for (const section of result.sections) {
      if (section.passed) {
        console.log(`  ${c.green}✓${c.reset} ${section.name}  ${c.dim}(${section.points}pts)${c.reset}`)
      } else {
        console.log(`  ${c.red}✗${c.reset} ${section.name}  ${c.dim}(0/${section.points}pts)${c.reset}`)
        console.log(`    ${c.dim}→ ${section.missingImpact}${c.reset}`)
      }
    }

    const scoreColor = result.score >= 80 ? c.green : result.score >= 40 ? c.yellow : c.red
    console.log(`\n  score  ${scoreColor}${result.score}/100${c.reset}\n`)
  }

  if (files.length > 1) {
    const avg = Math.round(files.reduce((sum, f) => {
      const content = readFile(f) || ''
      return sum + scoreFile(content).score
    }, 0) / files.length)
    const avgColor = avg >= 80 ? c.green : avg >= 40 ? c.yellow : c.red
    console.log(`  ${c.bold}average${c.reset}  ${avgColor}${avg}/100${c.reset}\n`)
  }
}
