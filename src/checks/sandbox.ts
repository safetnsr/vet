import { join } from 'node:path'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { readFile, c } from '../util.js'
import type { CheckResult, Issue } from '../types.js'

// ── Constants ────────────────────────────────────────────────────────────────

const SENSITIVE_DIRS = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.config/gcloud',
  '~/.kube',
  '~/.docker',
  '~/.npmrc',
  '~/.pypirc',
  '~/.netrc',
]

const ENV_PATTERNS = [
  /KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /AUTH/i,
]

const NETWORK_RESTRICTION_PATTERNS = [
  /allowedUrls/i,
  /blockedUrls/i,
  /networkRestrict/i,
  /network.*allow/i,
  /network.*block/i,
  /allowlist/i,
  /denylist/i,
  /block.*network/i,
]

// ── Probe 1: Sensitive dirs ───────────────────────────────────────────────────

function probeSensitiveDirs(): { deduction: number; issues: Issue[] } {
  const issues: Issue[] = []
  let deduction = 0
  const home = homedir()

  for (const dir of SENSITIVE_DIRS) {
    const resolved = dir.replace('~', home)
    try {
      statSync(resolved)
      // accessible
      deduction += 1
      issues.push({
        severity: 'error',
        message: `Sensitive directory accessible: ${dir}`,
        fixable: false,
        fixHint: 'Run agent in a sandboxed environment (Docker, VM, chroot) to restrict fs access',
      })
    } catch {
      // not accessible — good
    }
  }

  return { deduction, issues }
}

// ── Probe 2: Env var leaks ────────────────────────────────────────────────────

function probeEnvVars(): { deduction: number; issues: Issue[] } {
  const issues: Issue[] = []
  let rawDeduction = 0

  for (const key of Object.keys(process.env)) {
    const matches = ENV_PATTERNS.some(re => re.test(key))
    if (matches) {
      rawDeduction += 0.5
      issues.push({
        severity: 'warning',
        message: `Sensitive env var exposed: ${key}`,
        fixable: false,
        fixHint: 'Use a secrets manager or strip sensitive vars before running agent',
      })
    }
  }

  const deduction = Math.min(rawDeduction, 3)
  return { deduction, issues }
}

// ── Probe 3: Network rules ────────────────────────────────────────────────────

function probeNetworkRules(cwd: string): { deduction: number; issues: Issue[] } {
  const issues: Issue[] = []
  let deduction = 0

  const filesToCheck = ['CLAUDE.md', 'AGENTS.md']
  let found = false

  for (const filename of filesToCheck) {
    const content = readFile(join(cwd, filename))
    if (!content) continue
    const hasRestriction = NETWORK_RESTRICTION_PATTERNS.some(re => re.test(content))
    if (hasRestriction) {
      found = true
      break
    }
  }

  if (!found) {
    deduction = 1
    issues.push({
      severity: 'warning',
      message: 'No network restriction rules found in CLAUDE.md or AGENTS.md',
      fixable: false,
      fixHint: 'Add allowedUrls or blockedUrls rules to CLAUDE.md to limit agent network access',
    })
  }

  return { deduction, issues }
}

// ── Probe 4: MCP permissions ──────────────────────────────────────────────────

function probeMcpPermissions(cwd: string): { deduction: number; issues: Issue[] } {
  const issues: Issue[] = []
  let rawDeduction = 0

  const settingsPath = join(cwd, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) {
    issues.push({
      severity: 'info',
      message: 'No .claude/settings.json found — cannot audit MCP permissions',
      fixable: false,
      fixHint: 'Create .claude/settings.json with explicit MCP permission scopes',
    })
    return { deduction: 0, issues }
  }

  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch {
    issues.push({
      severity: 'warning',
      message: 'Failed to parse .claude/settings.json',
      file: '.claude/settings.json',
      fixable: false,
    })
    return { deduction: 0, issues }
  }

  // Check mcpServers for tools with filesystem:write or no path restrictions
  const mcpServers = (settings.mcpServers as Record<string, unknown>) || {}
  for (const [serverName, server] of Object.entries(mcpServers)) {
    const srv = server as Record<string, unknown>
    const tools = (srv.tools as Record<string, unknown>[]) || []

    for (const tool of tools) {
      const permissions = (tool.permissions as string[]) || []
      const hasWriteAccess = permissions.includes('filesystem:write')
      const hasNoPathRestriction = !permissions.some(p => p.startsWith('path:'))

      if (hasWriteAccess && hasNoPathRestriction) {
        rawDeduction += 1
        issues.push({
          severity: 'error',
          message: `MCP tool with unrestricted filesystem:write: ${serverName}/${tool.name || 'unknown'}`,
          file: '.claude/settings.json',
          fixable: false,
          fixHint: 'Add path: restrictions to limit filesystem write access',
        })
      }
    }

    // Also check top-level permissions on the server
    const serverPermissions = (srv.permissions as string[]) || []
    const hasWriteAccess = serverPermissions.includes('filesystem:write')
    const hasNoPathRestriction = !serverPermissions.some((p: string) => p.startsWith('path:'))

    if (hasWriteAccess && hasNoPathRestriction) {
      rawDeduction += 1
      issues.push({
        severity: 'error',
        message: `MCP server with unrestricted filesystem:write: ${serverName}`,
        file: '.claude/settings.json',
        fixable: false,
        fixHint: 'Add path: restrictions to limit filesystem write access',
      })
    }
  }

  const deduction = Math.min(rawDeduction, 2)
  return { deduction, issues }
}

// ── Blast radius score ────────────────────────────────────────────────────────

function blastRadiusLabel(score: number): string {
  if (score >= 9) return 'minimal — agent is tightly sandboxed'
  if (score >= 7) return 'low — some exposure, mostly contained'
  if (score >= 5) return 'moderate — agent can access sensitive resources'
  if (score >= 3) return 'high — agent has broad filesystem and secret access'
  return 'critical — agent is running in a fully open environment'
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkSandbox(cwd: string): Promise<CheckResult> {
  const allIssues: Issue[] = []

  const sensitiveDirs = probeSensitiveDirs()
  const envVars = probeEnvVars()
  const networkRules = probeNetworkRules(cwd)
  const mcpPerms = probeMcpPermissions(cwd)

  allIssues.push(...sensitiveDirs.issues)
  allIssues.push(...envVars.issues)
  allIssues.push(...networkRules.issues)
  allIssues.push(...mcpPerms.issues)

  const totalDeduction = sensitiveDirs.deduction + envVars.deduction + networkRules.deduction + mcpPerms.deduction
  const sandboxScore = Math.max(0, Math.min(10, 10 - totalDeduction))
  const score = Math.round(sandboxScore * 10)

  const label = blastRadiusLabel(sandboxScore)
  const summary = `blast radius score ${sandboxScore.toFixed(1)}/10 — ${label}`

  return {
    name: 'sandbox',
    score,
    maxScore: 100,
    issues: allIssues,
    summary,
  }
}

// ── Subcommand output ────────────────────────────────────────────────────────

export async function runSandboxCommand(cwd: string, flags: Set<string>): Promise<void> {
  const result = await checkSandbox(cwd)
  const sandboxScore = result.score / 10

  if (flags.has('--json')) {
    console.log(JSON.stringify({
      score: sandboxScore,
      scoreOutOf100: result.score,
      maxScore: result.maxScore,
      blastRadius: blastRadiusLabel(sandboxScore),
      issues: result.issues,
      summary: result.summary,
    }, null, 2))
    return
  }

  console.log(`\n  ${c.bold}vet sandbox${c.reset} — agent runtime blast radius\n`)

  // Table header
  const labelW = 30
  const statusW = 12

  console.log(`  ${c.dim}${'─'.repeat(labelW + statusW + 6)}${c.reset}`)
  console.log(`  ${pad('Probe', labelW)} ${pad('Status', statusW)}`)
  console.log(`  ${c.dim}${'─'.repeat(labelW + statusW + 6)}${c.reset}`)

  // Probe 1: Sensitive dirs
  const sensitiveDirIssues = result.issues.filter(i => i.message.startsWith('Sensitive directory'))
  const sensitiveDirStatus = sensitiveDirIssues.length === 0
    ? `${c.green}PASS${c.reset}`
    : `${c.red}FAIL (${sensitiveDirIssues.length})${c.reset}`
  console.log(`  ${pad('Sensitive dirs', labelW)} ${sensitiveDirStatus}`)
  for (const issue of sensitiveDirIssues) {
    console.log(`    ${c.red}✗${c.reset} ${issue.message}`)
  }

  // Probe 2: Env var leaks
  const envIssues = result.issues.filter(i => i.message.startsWith('Sensitive env var'))
  const envStatus = envIssues.length === 0
    ? `${c.green}PASS${c.reset}`
    : `${c.yellow}WARN (${envIssues.length})${c.reset}`
  console.log(`  ${pad('Env var exposure', labelW)} ${envStatus}`)
  for (const issue of envIssues.slice(0, 5)) {
    console.log(`    ${c.yellow}⚠${c.reset} ${issue.message}`)
  }
  if (envIssues.length > 5) {
    console.log(`    ${c.dim}... and ${envIssues.length - 5} more${c.reset}`)
  }

  // Probe 3: Network rules
  const netIssues = result.issues.filter(i => i.message.includes('network restriction'))
  const netStatus = netIssues.length === 0
    ? `${c.green}PASS${c.reset}`
    : `${c.yellow}WARN${c.reset}`
  console.log(`  ${pad('Network restrictions', labelW)} ${netStatus}`)
  for (const issue of netIssues) {
    console.log(`    ${c.yellow}⚠${c.reset} ${issue.message}`)
  }

  // Probe 4: MCP permissions
  const mcpIssues = result.issues.filter(i => i.message.includes('MCP'))
  const mcpInfoIssues = result.issues.filter(i => i.message.includes('.claude/settings.json'))
  const mcpStatus = mcpIssues.length > 0
    ? `${c.red}FAIL (${mcpIssues.length})${c.reset}`
    : mcpInfoIssues.length > 0
      ? `${c.dim}N/A${c.reset}`
      : `${c.green}PASS${c.reset}`
  console.log(`  ${pad('MCP permissions', labelW)} ${mcpStatus}`)
  for (const issue of mcpIssues) {
    console.log(`    ${c.red}✗${c.reset} ${issue.message}`)
  }

  console.log(`  ${c.dim}${'─'.repeat(labelW + statusW + 6)}${c.reset}`)

  // Score
  const scoreColor = sandboxScore >= 7 ? c.green : sandboxScore >= 4 ? c.yellow : c.red
  console.log(`\n  blast radius score  ${scoreColor}${sandboxScore.toFixed(1)}/10${c.reset}`)
  console.log(`  if compromised      ${blastRadiusLabel(sandboxScore)}\n`)
}

// ── String helpers ───────────────────────────────────────────────────────────

function pad(s: string, w: number): string {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, '')
  return s + ' '.repeat(Math.max(0, w - clean.length))
}
