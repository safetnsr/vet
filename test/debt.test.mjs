import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { checkDebt } from '../src/checks/debt.js';

function makeTempProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vet-debt-test-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  execSync('git init && git add -A && git commit -m "init" --allow-empty', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

describe('checkDebt', () => {
  // 1. clean project = score 10
  test('clean project scores 100 with no issues', async () => {
    const dir = makeTempProject({
      'src/a.ts': `function processOrder(order) {
  if (!order.items || order.items.length === 0) throw new Error("empty");
  const total = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = total * 0.21;
  const shipping = total > 100 ? 0 : 9.95;
  return { total, tax, shipping, grand: total + tax + shipping };
}`,
      'src/b.ts': `function renderChart(data, canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const point of data) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}`,
    });
    const result = await checkDebt(dir, []);
    assert.strictEqual(result.name, 'debt');
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.issues.length, 0);
    cleanup(dir);
  });

  // 2. identical functions in different files detected as duplicates
  test('identical functions in different files detected', async () => {
    const body = `export function processData(input) {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}`;
    const dir = makeTempProject({
      'src/a.ts': body,
      'src/b.ts': body.replace('processData', 'handleData'),
    });
    const result = await checkDebt(dir, []);
    const dups = result.issues.filter(i => i.message.includes('duplicate') || i.message.includes('similar'));
    assert.ok(dups.length >= 1, `expected duplicates, got: ${JSON.stringify(result.issues)}`);
    assert.ok(result.score < 100);
    cleanup(dir);
  });

  // 3. identical functions in same file detected
  test('identical functions in same file detected', async () => {
    const dir = makeTempProject({
      'src/a.ts': `
function processAlpha(input) {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}
function processBeta(input) {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}`,
    });
    const result = await checkDebt(dir, []);
    const dups = result.issues.filter(i => i.message.includes('duplicate') || i.message.includes('similar'));
    assert.ok(dups.length >= 1, `expected duplicates in same file`);
    cleanup(dir);
  });

  // 4. similar but below threshold not flagged
  test('different functions not flagged as duplicates', async () => {
    const dir = makeTempProject({
      'src/a.ts': `export function alpha() {
  const x = getDataFromRemoteServer();
  const y = transformComplexPayload(x);
  return formatOutputResult(y);
}`,
      'src/b.ts': `export function beta() {
  const users = fetchAllActiveUsers();
  const sorted = sortByCreationDate(users);
  const paginated = paginateResults(sorted, 10);
  return renderUserTable(paginated);
}`,
    });
    const result = await checkDebt(dir, []);
    const dups = result.issues.filter(i => i.message.includes('duplicate') || i.message.includes('similar'));
    assert.strictEqual(dups.length, 0, 'different functions should not be flagged');
    cleanup(dir);
  });

  // 5. orphaned export detected
  test('orphaned export detected', async () => {
    const dir = makeTempProject({
      'src/utils.ts': `export function unusedHelper() {
  const result = doSomethingElaborate();
  return result;
}
export function usedHelper() {
  const result = doAnotherThing();
  return result;
}`,
      'src/main.ts': '', // entry file — skipped for export scanning
      'src/app.ts': `import { usedHelper } from "./utils.js";\nconsole.log(usedHelper());`,
    });
    const result = await checkDebt(dir, []);
    const orphans = result.issues.filter(i => i.message.includes('orphaned'));
    assert.ok(orphans.length >= 1, `expected orphaned export for unusedHelper`);
    assert.ok(orphans.some(o => o.message.includes('unusedHelper')));
    cleanup(dir);
  });

  // 6. used export NOT flagged
  test('used export not flagged as orphaned', async () => {
    const dir = makeTempProject({
      'src/utils.ts': `export function helper() {
  const result = doSomethingElaborate();
  return result;
}`,
      'src/app.ts': `import { helper } from "./utils.js";\nconsole.log(helper());`,
    });
    const result = await checkDebt(dir, []);
    const orphans = result.issues.filter(i => i.message.includes('orphaned') && i.message.includes('helper'));
    assert.strictEqual(orphans.length, 0, 'used export should not be flagged');
    cleanup(dir);
  });

  // 7. barrel file exports not flagged
  test('barrel file exports not flagged as orphaned', async () => {
    const dir = makeTempProject({
      'src/index.ts': `export function barrelExport() {
  const result = doSomethingElaborate();
  return result;
}`,
    });
    const result = await checkDebt(dir, []);
    const orphans = result.issues.filter(i => i.message.includes('orphaned'));
    assert.strictEqual(orphans.length, 0, 'barrel file exports should be skipped');
    cleanup(dir);
  });

  // 8. wrapper function detected
  test('wrapper function detected', async () => {
    const dir = makeTempProject({
      'src/a.ts': `function wrapper(a, b) {
  return originalFunction(a, b);
}`,
    });
    const result = await checkDebt(dir, []);
    const wrappers = result.issues.filter(i => i.message.includes('wrapper'));
    assert.ok(wrappers.length >= 1, `expected wrapper detection`);
    cleanup(dir);
  });

  // 9. real function not flagged as wrapper
  test('real function with logic not flagged as wrapper', async () => {
    const dir = makeTempProject({
      'src/a.ts': `function realFunction(a, b) {
  const validated = validateInput(a);
  const processed = transformData(validated, b);
  if (processed.error) throw new Error(processed.error);
  return formatResult(processed.data);
}`,
    });
    const result = await checkDebt(dir, []);
    const wrappers = result.issues.filter(i => i.message.includes('wrapper'));
    assert.strictEqual(wrappers.length, 0, 'real function should not be flagged as wrapper');
    cleanup(dir);
  });

  // 10. naming drift with 3+ variants detected
  test('naming drift with 3+ variants detected', async () => {
    const dir = makeTempProject({
      'src/a.ts': `function getUser() {
  const result = queryDatabaseForActiveUser();
  return result;
}`,
      'src/b.ts': `function fetchUser() {
  const result = callRemoteApiEndpointForUser();
  return result;
}`,
      'src/c.ts': `function loadUser() {
  const result = readUserFromLocalCacheStore();
  return result;
}`,
    });
    const result = await checkDebt(dir, []);
    const drift = result.issues.filter(i => i.message.includes('naming drift'));
    assert.ok(drift.length >= 1, `expected naming drift for User`);
    cleanup(dir);
  });

  // 11. naming with only 2 variants NOT flagged
  test('naming with only 2 variants not flagged', async () => {
    const dir = makeTempProject({
      'src/a.ts': `function getUser() {
  const result = queryDatabaseForActiveUser();
  return result;
}`,
      'src/b.ts': `function fetchUser() {
  const result = callRemoteApiEndpointForUser();
  return result;
}`,
    });
    const result = await checkDebt(dir, []);
    const drift = result.issues.filter(i => i.message.includes('naming drift'));
    assert.strictEqual(drift.length, 0, 'only 2 variants should not trigger drift');
    cleanup(dir);
  });

  // 12. mixed issues lower score correctly
  test('mixed issues lower score correctly', async () => {
    const body = `export function duplicate(input) {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}`;
    const dir = makeTempProject({
      'src/a.ts': body,
      'src/b.ts': body.replace('duplicate', 'copycat'),
      'src/utils.ts': `export function orphaned() {
  const result = doSomethingElaborate();
  return result;
}`,
      'src/wrap.ts': `function passthrough(x, y) {
  return innerFunc(x, y);
}`,
    });
    const result = await checkDebt(dir, []);
    assert.ok(result.score < 100, 'mixed issues should lower score');
    assert.ok(result.issues.length >= 2, 'should have multiple issues');
    cleanup(dir);
  });

  // 13. score floors at 0
  test('score floors at 0 with many issues', async () => {
    const makeFunc = (name) => `export function ${name}(input) {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}\n`;
    // Many duplicate groups — enough to exceed -10
    const dir = makeTempProject({
      'src/a.ts': makeFunc('procA') + makeFunc('procB') + makeFunc('procC'),
      'src/b.ts': makeFunc('procD') + makeFunc('procE') + makeFunc('procF'),
      'src/c.ts': makeFunc('procG') + makeFunc('procH') + makeFunc('procI'),
    });
    const result = await checkDebt(dir, []);
    assert.ok(result.score >= 0, 'score should not go below 0');
    cleanup(dir);
  });

  // 14. empty project = score 100
  test('empty project scores 100', async () => {
    const dir = makeTempProject({});
    const result = await checkDebt(dir, []);
    assert.strictEqual(result.score, 100);
    assert.strictEqual(result.issues.length, 0);
    cleanup(dir);
  });

  // 15. ignores node_modules / dist files
  test('ignores node_modules and dist files', async () => {
    const body = `export function dup(input) {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}`;
    const dir = makeTempProject({
      'node_modules/pkg/index.ts': body,
      'dist/bundle.js': body,
      'src/clean.ts': 'export function clean() {\n  const r = doStuff();\n  return r;\n}\n',
    });
    const result = await checkDebt(dir, []);
    const dups = result.issues.filter(i => i.message.includes('duplicate') || i.message.includes('similar'));
    assert.strictEqual(dups.length, 0, 'node_modules/dist should be ignored');
    cleanup(dir);
  });

  // 16. handles .tsx and .jsx files
  test('handles .tsx and .jsx files', async () => {
    const body = `export function Component(props) {
  const cleaned = props.data.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
}`;
    const dir = makeTempProject({
      'src/A.tsx': body,
      'src/B.jsx': body.replace('Component', 'OtherComponent'),
    });
    const result = await checkDebt(dir, []);
    const dups = result.issues.filter(i => i.message.includes('duplicate') || i.message.includes('similar'));
    assert.ok(dups.length >= 1, 'should detect duplicates in tsx/jsx files');
    cleanup(dir);
  });

  // 17. arrow function duplicates detected
  test('arrow function duplicates detected', async () => {
    const dir = makeTempProject({
      'src/a.ts': `export const processAlpha = (input) => {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
};`,
      'src/b.ts': `export const processBeta = (input) => {
  const cleaned = input.trim().toLowerCase();
  const parts = cleaned.split(",");
  const filtered = parts.filter(p => p.length > 0);
  const mapped = filtered.map(p => p.toUpperCase());
  return mapped.join(";");
};`,
    });
    const result = await checkDebt(dir, []);
    const dups = result.issues.filter(i => i.message.includes('duplicate') || i.message.includes('similar'));
    assert.ok(dups.length >= 1, 'should detect arrow function duplicates');
    cleanup(dir);
  });
});
