import { join, basename, dirname } from 'node:path';
import { walkFiles } from '../util.js';
import { cachedRead } from '../file-cache.js';
import type { CheckResult, Issue } from '../types.js';

const TEST_FILE_RE = /\.(test|spec)\.(ts|js|tsx|jsx)$/;
const TEST_DIR_RE = /(?:^|[/\\])(__tests__|tests?)[/\\]/;

function isTestFile(relPath: string): boolean {
  return TEST_FILE_RE.test(relPath) || TEST_DIR_RE.test(relPath);
}

/** Test utility/helper file patterns — these export helpers, not actual tests */
const TEST_UTILITY_NAMES = /(?:^|[/\\])(?:util(?:itie)?s?|helpers?|fixtures?|mocks?|setup|factor(?:y|ies)|themes?|test-(?:utils?|helpers?|setup|fixtures?|mocks?|themes?))\.[jt]sx?$/i;

function isTestUtilityFile(relPath: string, content: string): boolean {
  const hasTestCalls = /\b(?:test|it|describe|Deno\.test)\s*\(/.test(content);
  // Check filename pattern — but only if no test runner calls present
  const base = basename(relPath);
  if (TEST_UTILITY_NAMES.test(base) && !hasTestCalls) return true;
  // If in a test dir, has exports, but no test runner calls — it's a utility
  if (TEST_DIR_RE.test(relPath)) {
    const hasExports = /\bexport\s+(function|const|let|var|class|default|{)/.test(content);
    if (hasExports && !hasTestCalls) return true;
  }
  return false;
}

// Pattern 1: Tautological assertions
function findTautological(lines: string[], file: string): Issue[] {
  const issues: Issue[] = [];

  // expect(literal).toBe(literal) or .toEqual(literal)
  const expectLiteral = /expect\(([^)]+)\)\s*\.\s*(?:toBe|toEqual)\(\s*([^)]+)\s*\)/;
  // assert.strictEqual(x, x)
  const assertStrictEqual = /assert\.strictEqual\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m1 = line.match(expectLiteral);
    if (m1) {
      const left = m1[1].trim();
      const right = m1[2].trim();
      if (left === right) {
        issues.push({
          severity: 'error',
          message: `tautological assertion: expect(${left}).toBe/toEqual(${right})`,
          file, line: i + 1, fixable: false,
          fixHint: 'assert on actual behavior, not constant values',
        });
      }
    }
    const m2 = line.match(assertStrictEqual);
    if (m2) {
      const left = m2[1].trim();
      const right = m2[2].trim();
      if (left === right) {
        issues.push({
          severity: 'error',
          message: `tautological assertion: assert.strictEqual(${left}, ${left})`,
          file, line: i + 1, fixable: false,
          fixHint: 'compare different values — input vs expected output',
        });
      }
    }
  }
  return issues;
}

// Pattern 2: Empty test bodies
function findEmptyBodies(content: string, file: string): Issue[] {
  const issues: Issue[] = [];
  // Match it/test with arrow or function, empty body
  const re = /(?:^|\n)([ \t]*(?:it|test)\s*\([^,]+,\s*(?:(?:async\s+)?(?:\(\)\s*=>|\([^)]*\)\s*=>|function\s*\([^)]*\)))\s*\{([\s]*)\}\s*\))/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const body = m[2];
    // body should be empty or whitespace/comments only
    const stripped = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (stripped === '') {
      const line = content.substring(0, m.index).split('\n').length;
      issues.push({
        severity: 'error',
        message: 'empty test body — test does nothing',
        file, line, fixable: false,
        fixHint: 'add actual test logic or remove the test',
      });
    }
  }
  return issues;
}

// Pattern 3: Todo / skipped tests
function findTodoSkipped(lines: string[], file: string): Issue[] {
  const issues: Issue[] = [];
  const todoRe = /(?:it|test)\.todo\s*\(/;
  const skippedRe = /(?:^|\s)(?:xit|xtest|xdescribe)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    if (todoRe.test(lines[i])) {
      issues.push({
        severity: 'warning',
        message: 'todo test — placeholder with no implementation',
        file, line: i + 1, fixable: false,
        fixHint: 'implement the test or remove the placeholder',
      });
    }
    if (skippedRe.test(lines[i])) {
      issues.push({
        severity: 'warning',
        message: 'skipped test — disabled with x prefix',
        file, line: i + 1, fixable: false,
        fixHint: 'fix and re-enable or remove the skipped test',
      });
    }
  }
  return issues;
}

// Pattern 4: Zero-assertion tests
// We need to find test blocks with code but no assertions
function findZeroAssertionTests(content: string, file: string): Issue[] {
  const issues: Issue[] = [];
  // Find it(...) or test(...) blocks - simplified regex for the opening
  const testBlockRe = /(?:^|\n)([ \t]*)(?:it|test)\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*(?:async\s+)?(?:\(\)\s*=>|\([^)]*\)\s*=>|function\s*\([^)]*\))\s*\{/g;
  let m;
  while ((m = testBlockRe.exec(content)) !== null) {
    const startIdx = m.index + m[0].length;
    // Find matching closing brace
    let depth = 1;
    let i = startIdx;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) continue;
    const body = content.substring(startIdx, i - 1);
    const stripped = body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (stripped === '') continue; // empty body handled elsewhere
    // Check for assertion calls
    const assertionRe = /(?:expect\s*\(|assert\.|\.should\.|toBe\s*\(|toEqual\s*\(|toMatch\s*\(|toThrow\s*\()/;
    if (!assertionRe.test(body)) {
      // If every non-empty, non-comment statement is a function call, it's delegating to a helper
      const stmts = stripped.split(/;\s*|\n/).map(s => s.trim()).filter(s => s && !s.startsWith('//'));
      const delegatingRe = /^(await\s+)?[a-zA-Z_$][a-zA-Z0-9_$.]*\s*\(/;
      if (stmts.length > 0 && stmts.length <= 3 && stmts.every(s => delegatingRe.test(s))) continue;
      const line = content.substring(0, m.index).split('\n').length;
      issues.push({
        severity: 'warning',
        message: 'test has code but no assertions',
        file, line, fixable: false,
        fixHint: 'add expect() or assert calls to verify behavior',
      });
    }
  }
  return issues;
}

// Pattern 5: Mock-only tests
function findMockOnlyTests(content: string, file: string): Issue[] {
  const issues: Issue[] = [];
  const testBlockRe = /(?:^|\n)([ \t]*)(?:it|test)\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*(?:async\s+)?(?:\(\)\s*=>|\([^)]*\)\s*=>|function\s*\([^)]*\))\s*\{/g;
  let m;
  while ((m = testBlockRe.exec(content)) !== null) {
    const startIdx = m.index + m[0].length;
    let depth = 1;
    let i = startIdx;
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) continue;
    const body = content.substring(startIdx, i - 1);

    // Find all expect lines
    const expectLines = body.split('\n').filter(l => /expect\s*\(/.test(l));
    if (expectLines.length === 0) continue;

    const mockRe = /\.mock|mockFn|jest\.fn|vi\.fn/;
    const allMock = expectLines.every(l => mockRe.test(l));
    if (allMock) {
      const line = content.substring(0, m.index).split('\n').length;
      issues.push({
        severity: 'info',
        message: 'test only asserts on mocks — no real behavior verified',
        file, line, fixable: false,
        fixHint: 'add assertions on actual return values or side effects',
      });
    }
  }
  return issues;
}

// Pattern 6: Duplicate describe blocks
function findDuplicateDescribes(lines: string[], file: string): Issue[] {
  const issues: Issue[] = [];
  const describeRe = /describe\s*\(\s*(['"`])([^'"`]+)\1/;
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(describeRe);
    if (m) {
      const name = m[2];
      if (seen.has(name)) {
        issues.push({
          severity: 'info',
          message: `duplicate describe block: "${name}"`,
          file, line: i + 1, fixable: false,
          fixHint: 'merge duplicate describe blocks into one',
        });
      } else {
        seen.set(name, i + 1);
      }
    }
  }
  return issues;
}

/** Check if a file has a vet-ignore directive for a specific check in its first 5 lines.
 *  Format: // vet-ignore: check-name  OR  /* vet-ignore: check-name */
export function hasVetIgnore(content: string, checkName: string): boolean {
  const firstLines = content.split('\n').slice(0, 5);
  const re = new RegExp(`(?://|/\\*|#)\\s*vet-ignore:\\s*${checkName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return firstLines.some(line => re.test(line));
}

export function checkTests(cwd: string, ignore: string[]): CheckResult {
  const allFiles = walkFiles(cwd, ignore);
  const testFiles = allFiles.filter(f => isTestFile(f));
  const issues: Issue[] = [];

  for (const rel of testFiles) {
    let content: string;
    try {
      content = cachedRead(join(cwd, rel));
    } catch {
      continue;
    }

    // Skip files with vet-ignore: tests directive
    if (hasVetIgnore(content, 'tests')) continue;

    // Skip test utility/helper files — they export helpers, not tests
    if (isTestUtilityFile(rel, content)) continue;

    const lines = content.split('\n');

    issues.push(...findTautological(lines, rel));
    issues.push(...findEmptyBodies(content, rel));
    issues.push(...findTodoSkipped(lines, rel));
    issues.push(...findZeroAssertionTests(content, rel));
    issues.push(...findMockOnlyTests(content, rel));
    issues.push(...findDuplicateDescribes(lines, rel));
  }

  let score = 100;
  for (const issue of issues) {
    if (issue.severity === 'error') score -= 8;
    else if (issue.severity === 'warning') score -= 4;
    else score -= 2;
  }
  score = Math.max(0, score);

  const summary = issues.length > 0
    ? `${issues.length} test anti-pattern${issues.length !== 1 ? 's' : ''} found across ${testFiles.length} test file${testFiles.length !== 1 ? 's' : ''}`
    : 'no test anti-patterns found';

  return { name: 'tests', score, maxScore: 100, issues, summary };
}
