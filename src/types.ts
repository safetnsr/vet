export interface CheckResult {
  name: string;
  score: number;        // 0-10
  maxScore: number;     // always 10
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

export interface VetResult {
  project: string;
  score: number;
  checks: CheckResult[];
  totalIssues: number;
  fixableIssues: number;
  timestamp: string;
}

export interface VetConfig {
  checks?: string[];
  ignore?: string[];
  thresholds?: { min?: number };
  agents?: string[];
}
