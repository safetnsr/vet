import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CheckResult, Issue } from '../types.js';

// ── Shannon entropy ──────────────────────────────────────────────────────────

function calculateEntropy(str: string): number {
  if (str.length === 0) return 0;
  const freq: Record<string, number> = {};
  for (const ch of str) freq[ch] = (freq[ch] ?? 0) + 1;
  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isHighEntropy(str: string): boolean {
  if (str.length < 20) return false;
  if (!/^[a-zA-Z0-9+/=_-]+$/.test(str)) return false;
  return calculateEntropy(str) > 4.5;
}

// ── Front-leak patterns (build output) ──────────────────────────────────────

interface LeakPattern {
  name: string;
  regex: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'info';
}

const LEAK_PATTERNS: LeakPattern[] = [
  { name: 'Google API Key', regex: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high' },
  { name: 'Stripe Secret Key', regex: /sk_live_[0-9a-zA-Z]{24,}/g, severity: 'critical' },
  { name: 'Stripe Publishable Key', regex: /pk_live_[0-9a-zA-Z]{24,}/g, severity: 'info' },
  { name: 'Anthropic API Key', regex: /sk-ant-[a-zA-Z0-9_-]{40,}/g, severity: 'critical' },
  { name: 'OpenAI API Key', regex: /sk-(?!live_)[a-zA-Z0-9]{20,}/g, severity: 'critical' },
  { name: 'GitHub Token (ghp)', regex: /ghp_[a-zA-Z0-9]{36}/g, severity: 'critical' },
  { name: 'GitHub Token (gho)', regex: /gho_[a-zA-Z0-9]{36}/g, severity: 'critical' },
  { name: 'GitHub Token (ghu)', regex: /ghu_[a-zA-Z0-9]{36}/g, severity: 'critical' },
  { name: 'GitHub Token (ghs)', regex: /ghs_[a-zA-Z0-9]{36}/g, severity: 'critical' },
  { name: 'GitHub Token (ghr)', regex: /ghr_[a-zA-Z0-9]{36}/g, severity: 'critical' },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, severity: 'critical' },
  { name: 'JWT Token', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g, severity: 'medium' },
  { name: 'Private Key', regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'critical' },
  { name: 'MongoDB Connection String', regex: /mongodb:\/\/[^\s'"]+/g, severity: 'high' },
  { name: 'Postgres Connection String', regex: /postgres:\/\/[^\s'"]+/g, severity: 'high' },
  { name: 'MySQL Connection String', regex: /mysql:\/\/[^\s'"]+/g, severity: 'high' },
  { name: 'Redis Connection String', regex: /redis:\/\/[^\s'"]+/g, severity: 'high' },
  { name: 'Slack Token', regex: /xox[bpsa]-[a-zA-Z0-9-]+/g, severity: 'critical' },
  { name: 'Twilio API Key', regex: /SK[a-f0-9]{32}/g, severity: 'high' },
  { name: 'SendGrid API Key', regex: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, severity: 'high' },
];

// ── sub-audit patterns (dev environment) ────────────────────────────────────

interface EnvPattern {
  provider: string;
  pattern: RegExp;
  envVars?: string[];
  costEstimate: string;
}

const ENV_PATTERNS: EnvPattern[] = [
  { provider: 'Anthropic', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/, envVars: ['ANTHROPIC_API_KEY'], costEstimate: '$20-500/mo' },
  { provider: 'OpenAI', pattern: /sk-proj-[a-zA-Z0-9_-]{20,}/, envVars: ['OPENAI_API_KEY'], costEstimate: '$20-1000/mo' },
  { provider: 'Google AI', pattern: /AIza[a-zA-Z0-9_-]{35}/, envVars: ['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY'], costEstimate: '$10-500/mo' },
  { provider: 'Replicate', pattern: /r8_[a-zA-Z0-9]{37}/, envVars: ['REPLICATE_API_TOKEN'], costEstimate: '$5-200/mo' },
  { provider: 'HuggingFace', pattern: /hf_[a-zA-Z0-9]{34}/, envVars: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], costEstimate: '$0-100/mo' },
  { provider: 'Groq', pattern: /gsk_[a-zA-Z0-9]{48,}/, envVars: ['GROQ_API_KEY'], costEstimate: '$0-50/mo' },
  { provider: 'Fireworks', pattern: /fw_[a-zA-Z0-9]{30,}/, envVars: ['FIREWORKS_API_KEY'], costEstimate: '$5-200/mo' },
  { provider: 'DeepSeek', pattern: /sk-[a-f0-9]{32,}/, envVars: ['DEEPSEEK_API_KEY'], costEstimate: '$5-100/mo' },
];

const ENV_ONLY_PROVIDERS = new Set(['Cohere', 'Mistral', 'Together']);

function detectEnvKeys(line: string): { provider: string; key: string; costEstimate: string }[] {
  const matches: { provider: string; key: string; costEstimate: string }[] = [];
  const seen = new Set<string>();

  for (const p of ENV_PATTERNS) {
    if (p.envVars) {
      for (const envVar of p.envVars) {
        const envRe = new RegExp(`${envVar}\\s*=\\s*["']?([^"'\\s#]+)["']?`);
        const m = line.match(envRe);
        if (m && m[1] && m[1].length >= 8 && !seen.has(m[1])) {
          seen.add(m[1]);
          matches.push({ provider: p.provider, key: m[1], costEstimate: p.costEstimate });
        }
      }
    }
    if (ENV_ONLY_PROVIDERS.has(p.provider)) continue;
    const m = line.match(p.pattern);
    if (m && m[0] && !seen.has(m[0])) {
      seen.add(m[0]);
      matches.push({ provider: p.provider, key: m[0], costEstimate: p.costEstimate });
    }
  }
  return matches;
}

function isGitTracked(filePath: string): boolean {
  try {
    const result = execSync(`git ls-files --error-unmatch "${filePath}"`, {
      cwd: dirname(filePath),
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

// ── Build output scanning ────────────────────────────────────────────────────

const SCANNABLE_EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map']);
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.wasm', '.zip', '.gz', '.br',
  '.mp4', '.mp3', '.wav', '.webm', '.pdf',
]);
const BUILD_DIRS = ['dist', 'build', '.next', 'out', 'public'];

function detectBuildDir(cwd: string): string | null {
  for (const candidate of BUILD_DIRS) {
    const full = join(cwd, candidate);
    if (existsSync(full) && statSync(full).isDirectory()) return full;
  }
  return null;
}

function walkBuild(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        results.push(...walkBuild(full));
      } else {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

function shouldScan(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (SKIP_EXTS.has(ext)) return false;
  return SCANNABLE_EXTS.has(ext);
}

async function scanBuildFile(filePath: string): Promise<{ name: string; severity: 'critical' | 'high' | 'medium' | 'info'; preview: string; line: number }[]> {
  const findings: { name: string; severity: 'critical' | 'high' | 'medium' | 'info'; preview: string; line: number }[] = [];
  const ext = extname(filePath).toLowerCase();

  if (ext === '.map') {
    findings.push({ name: 'Source Map', severity: 'medium', preview: 'Source map exposes original source code', line: 0 });
    return findings;
  }

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const lineText of rl) {
    lineNumber++;
    for (const pattern of LEAK_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.regex.exec(lineText)) !== null) {
        const masked = lineText.replace(m[0], m[0].slice(0, 4) + '****' + m[0].slice(-4));
        findings.push({ name: pattern.name, severity: pattern.severity, preview: masked.slice(0, 120), line: lineNumber });
        if (m[0].length === 0) { pattern.regex.lastIndex++; break; }
      }
      pattern.regex.lastIndex = 0;
    }
  }

  return findings;
}

// ── Dev environment scanning ─────────────────────────────────────────────────

function findEnvFiles(dir: string, maxDepth = 3, depth = 0): string[] {
  if (depth > maxDepth) return [];
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        if (entry.name === '.env' || entry.name.startsWith('.env.') || entry.name.endsWith('.env')) {
          files.push(full);
        }
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        files.push(...findEnvFiles(full, maxDepth, depth + 1));
      }
    }
  } catch { /* skip */ }
  return files;
}

function scanEnvFile(filePath: string): { provider: string; key: string; costEstimate: string; gitTracked: boolean; file: string }[] {
  const findings: { provider: string; key: string; costEstimate: string; gitTracked: boolean; file: string }[] = [];
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    const gitTracked = isGitTracked(filePath);
    for (const line of lines) {
      if (line.trimStart().startsWith('#')) continue;
      for (const m of detectEnvKeys(line)) {
        findings.push({ ...m, gitTracked, file: filePath });
      }
    }
  } catch { /* skip */ }
  return findings;
}

// ── Main check ───────────────────────────────────────────────────────────────

export async function checkSecrets(cwd: string): Promise<CheckResult> {
  const issues: Issue[] = [];

  // 1. Build output scan
  const buildDir = detectBuildDir(cwd);
  if (buildDir) {
    const buildFiles = walkBuild(buildDir).filter(f => shouldScan(f));
    for (const file of buildFiles) {
      try {
        const findings = await scanBuildFile(file);
        for (const f of findings) {
          issues.push({
            severity: f.severity === 'critical' ? 'error' : f.severity === 'high' ? 'warning' : 'info',
            message: `[build] ${f.name}: ${f.preview}`,
            file: relative(cwd, file),
            line: f.line || undefined,
            fixable: false,
          });
        }
      } catch { /* skip */ }
    }
  }

  // 2. .env files in project
  const envFiles = findEnvFiles(cwd);
  for (const envFile of envFiles) {
    const findings = scanEnvFile(envFile);
    for (const f of findings) {
      const relPath = relative(cwd, f.file);
      const severity = f.gitTracked ? 'error' : 'warning';
      issues.push({
        severity,
        message: `[env] ${f.provider} key in ${relPath}${f.gitTracked ? ' (git-tracked!)' : ''} — ${maskKey(f.key)} (${f.costEstimate})`,
        file: relPath,
        fixable: false,
        fixHint: f.gitTracked ? 'remove from git: git rm --cached ' + relPath : undefined,
      });
    }
  }

  // 3. Home dotfiles (shell history, rc files)
  const home = homedir();
  const dotfiles = ['.bashrc', '.zshrc', '.bash_profile', '.profile', '.zprofile'];
  for (const name of dotfiles) {
    const fp = join(home, name);
    if (!existsSync(fp)) continue;
    const findings = scanEnvFile(fp);
    for (const f of findings) {
      issues.push({
        severity: 'warning',
        message: `[home] ${f.provider} key in ~/${name} — ${maskKey(f.key)} (${f.costEstimate})`,
        file: `~/${name}`,
        fixable: false,
      });
    }
  }

  // Score: each critical issue = -3, warning = -1
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  const score = Math.max(0, Math.min(10, 10 - errors * 3 - warnings * 1));

  const buildNote = buildDir ? '' : ' (no build dir found)';
  return {
    name: 'secrets',
    score: Math.round(score * 10) / 10,
    maxScore: 10,
    issues,
    summary: issues.length === 0
      ? `no leaked secrets detected${buildNote}`
      : `${issues.length} secret${issues.length !== 1 ? 's' : ''} found${buildNote}`,
  };
}
