import { findSessionFiles, parseSessionFile } from './receipt.js';
import { c } from '../util.js';
import { statSync } from 'node:fs';
import type { CheckResult, Issue } from '../types.js';

// ── Pricing (per 1M tokens, USD) ─────────────────────────────────────────────

interface ModelPricing { input: number; output: number }

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-6': { input: 3,    output: 15 },
  'claude-sonnet-4-5': { input: 3,    output: 15 },
  'claude-haiku-3-5':  { input: 0.80, output: 4 },
  'gpt-5.4':           { input: 2.50, output: 10 },
  'gpt-4o':            { input: 2.50, output: 10 },
  'gemini-2.5-pro':    { input: 1.25, output: 10 },
};

const FALLBACK_PRICING: ModelPricing = { input: 3, output: 15 };

const SUBSCRIPTION_TIERS: Record<string, number> = {
  'claude-pro':      20,
  'claude-max-5x':   100,
  'claude-max-20x':  200,
  'chatgpt-plus':    20,
  'chatgpt-pro':     200,
};

const DEFAULT_SUBSCRIPTION = 20;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPricing(model: string): ModelPricing {
  // Try exact match first, then prefix match
  if (PRICING[model]) return PRICING[model];
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return FALLBACK_PRICING;
}

function getSubscriptionCost(plan: string): number {
  return SUBSCRIPTION_TIERS[plan] ?? DEFAULT_SUBSCRIPTION;
}

interface ModelCost {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface SubsidyData {
  sessionCount: number;
  periodStart: string;
  periodEnd: string;
  models: Record<string, ModelCost>;
  totalCost: number;
  subscriptionCost: number;
  subsidized: number;
  subsidyRate: number;
}

export function computeSubsidy(
  entries: Array<Record<string, unknown>>,
  plan: string,
): { models: Record<string, ModelCost>; totalCost: number; subscriptionCost: number; subsidized: number; subsidyRate: number } {
  const models: Record<string, ModelCost> = {};

  for (const entry of entries) {
    // Extract model and usage from entry or entry.message
    let model: string | undefined;
    let usage: Record<string, unknown> | undefined;

    if (entry.model && typeof entry.model === 'string') model = entry.model;
    if (entry.usage && typeof entry.usage === 'object') usage = entry.usage as Record<string, unknown>;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (msg) {
      if (!model && msg.model && typeof msg.model === 'string') model = msg.model;
      if (!usage && msg.usage && typeof msg.usage === 'object') usage = msg.usage as Record<string, unknown>;
    }

    if (!model || !usage) continue;

    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

    if (inputTokens === 0 && outputTokens === 0) continue;

    const pricing = getPricing(model);
    const cost = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;

    if (!models[model]) models[model] = { inputTokens: 0, outputTokens: 0, cost: 0 };
    models[model].inputTokens += inputTokens;
    models[model].outputTokens += outputTokens;
    models[model].cost += cost;
  }

  const totalCost = Object.values(models).reduce((sum, m) => sum + m.cost, 0);
  const subscriptionCost = getSubscriptionCost(plan);
  const subsidized = Math.max(0, totalCost - subscriptionCost);
  const subsidyRate = totalCost > 0 ? (subsidized / totalCost) * 100 : 0;

  return { models, totalCost, subscriptionCost, subsidized, subsidyRate };
}

// ── ASCII card ───────────────────────────────────────────────────────────────

function renderCard(data: SubsidyData): string {
  const W = 43;
  const hr = '─'.repeat(W);
  const pad = (s: string, w: number = W) => {
    const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
    const diff = w - visible.length;
    return diff > 0 ? s + ' '.repeat(diff) : s;
  };
  const line = (s: string) => `│ ${pad(s, W - 2)} │`;

  const lines: string[] = [];
  lines.push(`┌${hr}┐`);

  const title = 'YOUR AI COST THIS MONTH';
  const lp = Math.floor((W - 2 - title.length) / 2);
  const rp = W - 2 - title.length - lp;
  lines.push(`│${' '.repeat(lp + 1)}${title}${' '.repeat(rp + 1)}│`);
  lines.push(`├${hr}┤`);

  lines.push(line(`sessions analyzed:${' '.repeat(Math.max(1, W - 2 - 18 - String(data.sessionCount).length))}${data.sessionCount}`));
  const period = `${data.periodStart} — ${data.periodEnd}`;
  lines.push(line(`period:${' '.repeat(Math.max(1, W - 2 - 7 - period.length))}${period}`));
  lines.push(`├${hr}┤`);

  // Per-model breakdown sorted by cost desc
  const sorted = Object.entries(data.models).sort((a, b) => b[1].cost - a[1].cost);
  for (const [model, mc] of sorted) {
    const pct = data.totalCost > 0 ? Math.round((mc.cost / data.totalCost) * 100) : 0;
    const costStr = `$${mc.cost.toFixed(2)}`;
    const pctStr = `(${pct}%)`;
    const gap = Math.max(1, W - 2 - model.length - costStr.length - pctStr.length - 4);
    lines.push(line(`${model}${' '.repeat(gap)}${costStr}    ${pctStr}`));
  }

  lines.push(`├${hr}┤`);

  const fmtRow = (label: string, value: string) => {
    const gap = Math.max(1, W - 2 - label.length - value.length);
    return line(`${label}${' '.repeat(gap)}${value}`);
  };

  lines.push(fmtRow('USED (list price):', `$${data.totalCost.toFixed(2)}`));
  lines.push(fmtRow('PAID (subscription):', `$${data.subscriptionCost.toFixed(2)}`));
  lines.push(fmtRow('SUBSIDIZED:', `$${data.subsidized.toFixed(2)}`));
  lines.push(fmtRow('SUBSIDY RATE:', `${data.subsidyRate.toFixed(1)}%`));
  lines.push(`└${hr}┘`);

  return lines.join('\n');
}

// ── Check for vet scan ───────────────────────────────────────────────────────

export async function checkSubsidy(cwd: string): Promise<CheckResult> {
  const files = findSessionFiles();
  const issues: Issue[] = [];

  if (files.length === 0) {
    return {
      name: 'subsidy',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no session logs found', fixable: false }],
      summary: 'no session logs found',
    };
  }

  const allEntries: Record<string, unknown>[] = [];
  for (const f of files) {
    try {
      const { entries } = await parseSessionFile(f);
      allEntries.push(...entries);
    } catch { /* skip */ }
  }

  const result = computeSubsidy(allEntries, 'claude-pro');

  if (Object.keys(result.models).length === 0) {
    return {
      name: 'subsidy',
      score: 100,
      maxScore: 100,
      issues: [{ severity: 'info', message: 'no token usage data in sessions', fixable: false }],
      summary: 'no token usage data in sessions',
    };
  }

  issues.push({
    severity: 'info',
    message: `API list price: $${result.totalCost.toFixed(2)}, subscription: $${result.subscriptionCost.toFixed(2)}, subsidy: ${result.subsidyRate.toFixed(1)}%`,
    fixable: false,
  });

  return {
    name: 'subsidy',
    score: 100,
    maxScore: 100,
    issues,
    summary: `used $${result.totalCost.toFixed(2)} at list price (paid $${result.subscriptionCost.toFixed(2)}, subsidy ${result.subsidyRate.toFixed(1)}%)`,
  };
}

// ── Subcommand ───────────────────────────────────────────────────────────────

export async function runSubsidyCommand(format: 'ascii' | 'json', options?: { since?: string; plan?: string }): Promise<void> {
  const plan = options?.plan || 'claude-pro';
  const since = options?.since;

  let files = findSessionFiles();

  if (since) {
    const sinceDate = new Date(since);
    if (!isNaN(sinceDate.getTime())) {
      files = files.filter(f => {
        try { return statSync(f).mtimeMs >= sinceDate.getTime(); } catch { return false; }
      });
    }
  }

  if (files.length === 0) {
    if (format === 'json') {
      console.log(JSON.stringify({ error: 'no session files found' }));
    } else {
      console.error('no claude session files found in ~/.claude/projects/');
    }
    return;
  }

  const allEntries: Record<string, unknown>[] = [];
  let earliest = Infinity;
  let latest = -Infinity;

  for (const f of files) {
    try {
      const { entries } = await parseSessionFile(f);
      allEntries.push(...entries);
      const stat = statSync(f);
      if (stat.mtimeMs < earliest) earliest = stat.mtimeMs;
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch { /* skip */ }
  }

  const result = computeSubsidy(allEntries, plan);

  const data: SubsidyData = {
    sessionCount: files.length,
    periodStart: earliest === Infinity ? 'unknown' : new Date(earliest).toISOString().slice(0, 10),
    periodEnd: latest === -Infinity ? 'unknown' : new Date(latest).toISOString().slice(0, 10),
    models: result.models,
    totalCost: result.totalCost,
    subscriptionCost: result.subscriptionCost,
    subsidized: result.subsidized,
    subsidyRate: result.subsidyRate,
  };

  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(renderCard(data));
  }
}
