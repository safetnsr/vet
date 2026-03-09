export interface CheckResult {
  name: string;
  score: number;        // 0-100
  maxScore: number;     // always 100
  issues: Issue[];
  summary: string;
}

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  fixable: boolean;
  fixHint?: string;
}

export interface CategoryResult {
  name: 'security' | 'integrity' | 'debt' | 'deps' | 'architecture' | 'aiready';
  score: number;        // 0-100
  weight: number;       // 0.15-0.30
  checks: CheckResult[];
  issues: Issue[];
}

export interface VetResult {
  project: string;
  version: string;
  score: number;        // 0-100 weighted
  grade: string;        // A-F
  categories: CategoryResult[];
  totalIssues: number;
  fixableIssues: number;
  timestamp: string;
}

export interface VetConfig {
  checks?: string[];
  ignore?: string[];
  thresholds?: { min?: number; grade?: string };
  agents?: string[];
}

export interface DiffOptions {
  since?: string;
}
