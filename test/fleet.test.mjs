import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need to import from built output
import { analyzeFleet, checkFleet } from '../dist/checks/fleet.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vet-fleet-'));
}

function makeSessionDir(base) {
  // Mimics ~/.claude/projects/myproject/sessions/
  const dir = path.join(base, 'projects', 'test-project', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(dir, filename, entries) {
  const filePath = path.join(dir, filename);
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  return filePath;
}

function now() {
  return new Date().toISOString();
}

function minutesAgo(n) {
  return new Date(Date.now() - n * 60000).toISOString();
}

// ── Tool use entry helpers ───────────────────────────────────────────────────

function toolUse(name, input, timestamp) {
  return {
    type: 'assistant',
    timestamp: timestamp || now(),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  };
}

function writeCall(filePath, timestamp) {
  return toolUse('Write', { file_path: filePath }, timestamp);
}

function editCall(filePath, timestamp) {
  return toolUse('Edit', { file_path: filePath, old_string: 'a', new_string: 'b' }, timestamp);
}

function readCall(filePath, timestamp) {
  return toolUse('Read', { file_path: filePath }, timestamp);
}

function bashCall(cmd, timestamp) {
  return toolUse('Bash', { command: cmd }, timestamp);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('fleet: analyzeFleet', () => {
  let tmp;

  beforeEach(() => { tmp = tmpDir(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty when no session files', () => {
    const sessDir = makeSessionDir(tmp);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 0);
  });

  it('parses a single session with writes', () => {
    const sessDir = makeSessionDir(tmp);
    const ts1 = minutesAgo(10);
    const ts2 = minutesAgo(5);
    writeJsonl(sessDir, 'session-001.jsonl', [
      writeCall('src/app.ts', ts1),
      writeCall('src/util.ts', ts2),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].filesWritten, 2);
    assert.equal(result.sessions[0].status, 'OK');
  });

  it('detects silent failure (tool calls but no writes)', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-002.jsonl', [
      readCall('src/app.ts', minutesAgo(10)),
      readCall('src/util.ts', minutesAgo(9)),
      readCall('src/core.ts', minutesAgo(8)),
      bashCall('ls -la', minutesAgo(7)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].status, 'SILENT_FAIL');
    assert.equal(result.silentFails.length, 1);
  });

  it('does not flag silent fail when session has few calls', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-003.jsonl', [
      readCall('README.md', now()),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions[0].status, 'OK');
    assert.equal(result.silentFails.length, 0);
  });

  it('detects cross-agent conflicts', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'agent-A.jsonl', [
      writeCall('config/deploy.yml', minutesAgo(10)),
    ]);
    writeJsonl(sessDir, 'agent-B.jsonl', [
      writeCall('config/deploy.yml', minutesAgo(5)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 2);
    assert.equal(result.conflicts.size, 1);
    assert.ok(result.conflicts.has('config/deploy.yml'));
    // Both sessions should be marked CONFLICT
    const conflictSessions = result.sessions.filter(s => s.status === 'CONFLICT');
    assert.equal(conflictSessions.length, 2);
  });

  it('handles edit tool calls for file tracking', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-edit.jsonl', [
      editCall('src/main.ts', minutesAgo(5)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions[0].filesWritten, 1);
  });

  it('tracks read-only files separately', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-read.jsonl', [
      readCall('src/app.ts', minutesAgo(10)),
      writeCall('src/output.ts', minutesAgo(5)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions[0].filesWritten, 1);
    assert.equal(result.sessions[0].filesRead, 1);
  });

  it('calculates duration from first to last timestamp', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-dur.jsonl', [
      writeCall('a.ts', minutesAgo(20)),
      writeCall('b.ts', minutesAgo(10)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions[0].durationMin, 10);
  });

  it('counts total tool calls', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-calls.jsonl', [
      readCall('a.ts', now()),
      writeCall('b.ts', now()),
      bashCall('npm test', now()),
      editCall('c.ts', now()),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions[0].toolCalls, 4);
    assert.equal(result.totalToolCalls, 4);
  });

  it('handles malformed JSONL gracefully', () => {
    const sessDir = makeSessionDir(tmp);
    const filePath = path.join(sessDir, 'bad-session.jsonl');
    fs.writeFileSync(filePath, 'not json\n{}\n{"broken": true\n');
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].toolCalls, 0);
  });

  it('handles empty session file', () => {
    const sessDir = makeSessionDir(tmp);
    fs.writeFileSync(path.join(sessDir, 'empty.jsonl'), '');
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].toolCalls, 0);
  });

  it('conflict + silent fail on different sessions', () => {
    const sessDir = makeSessionDir(tmp);
    // Agent A writes config
    writeJsonl(sessDir, 'agent-A2.jsonl', [
      writeCall('config/app.yml', minutesAgo(10)),
    ]);
    // Agent B also writes config (conflict)
    writeJsonl(sessDir, 'agent-B2.jsonl', [
      writeCall('config/app.yml', minutesAgo(5)),
    ]);
    // Agent C reads only (silent fail)
    writeJsonl(sessDir, 'agent-C.jsonl', [
      readCall('src/a.ts', minutesAgo(8)),
      readCall('src/b.ts', minutesAgo(7)),
      readCall('src/c.ts', minutesAgo(6)),
      bashCall('echo hello', minutesAgo(5)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 3);
    assert.equal(result.conflicts.size, 1);
    assert.equal(result.silentFails.length, 1);
  });

  it('totalFiles counts unique files touched', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-tf.jsonl', [
      writeCall('a.ts', now()),
      writeCall('b.ts', now()),
      writeCall('a.ts', now()), // duplicate
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.totalFiles, 2);
  });

  it('multiple sessions without conflicts', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'agent-X.jsonl', [
      writeCall('src/x.ts', minutesAgo(10)),
    ]);
    writeJsonl(sessDir, 'agent-Y.jsonl', [
      writeCall('src/y.ts', minutesAgo(5)),
    ]);
    const result = analyzeFleet(path.join(tmp, 'projects'));
    assert.equal(result.sessions.length, 2);
    assert.equal(result.conflicts.size, 0);
    assert.ok(result.sessions.every(s => s.status === 'OK'));
  });
});

describe('fleet: checkFleet', () => {
  let tmp;

  beforeEach(() => { tmp = tmpDir(); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('returns perfect score with no sessions', () => {
    const sessDir = makeSessionDir(tmp);
    const result = checkFleet(path.join(tmp, 'projects'));
    assert.equal(result.name, 'fleet');
    assert.equal(result.score, 100);
  });

  it('reduces score for silent fails', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'session-sf.jsonl', [
      readCall('a.ts', now()),
      readCall('b.ts', now()),
      readCall('c.ts', now()),
      bashCall('ls', now()),
    ]);
    const result = checkFleet(path.join(tmp, 'projects'));
    assert.ok(result.score < 100);
    assert.ok(result.issues.some(i => i.severity === 'error'));
  });

  it('reduces score for conflicts', () => {
    const sessDir = makeSessionDir(tmp);
    writeJsonl(sessDir, 'a1.jsonl', [writeCall('x.ts', now())]);
    writeJsonl(sessDir, 'a2.jsonl', [writeCall('x.ts', now())]);
    const result = checkFleet(path.join(tmp, 'projects'));
    assert.ok(result.score < 100);
    assert.ok(result.issues.some(i => i.severity === 'warning'));
  });
});
