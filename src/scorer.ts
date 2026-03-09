import type { CheckResult, VetResult, CategoryResult } from './types.js';
import { buildCategories, buildVetResult } from './categories.js';

export interface CheckMap {
  security: CheckResult[];
  integrity: CheckResult[];
  debt: CheckResult[];
  deps: CheckResult[];
  architecture: CheckResult[];
  aiready: CheckResult[];
  history: CheckResult[];
}

export function score(project: string, checkMap: CheckMap): VetResult {
  const categories = buildCategories(checkMap);
  return buildVetResult(project, categories);
}
