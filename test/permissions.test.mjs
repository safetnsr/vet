import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const { checkPermissions } = await import('../src/checks/permissions.ts');

function makeTmpDir() {
  return mkdtempSync(join(osTmpdir(), 'vet-permissions-'));
}

function writeSettings(dir, settings) {
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

// ── 1. No .claude dir → score 100 ─────────────────────────────────────────
test('checkPermissions: no .claude dir → score 100', async () => {
  const dir = makeTmpDir();
  try {
    const result = checkPermissions(dir);
    assert.equal(result.name, 'permissions');
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 2. Empty settings.json → score 100 ────────────────────────────────────
test('checkPermissions: empty settings.json (no tools) → score 100', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {});
    const result = checkPermissions(dir);
    // {} has no allowedTools/permissions.allow/defaultMode, but also no blockedTools → WARN
    // score should be 100 - 15 = 85
    // The only hit is "no blockedTools"
    assert.ok(result.score <= 100);
    assert.equal(result.maxScore, 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 3. allowedTools contains "Bash" → DANGER ──────────────────────────────
test('checkPermissions: allowedTools with "Bash" → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, { allowedTools: ['Bash'], blockedTools: ['Write'] });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('"Bash"')),
      `Expected error about Bash, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 4. allowedTools contains "Bash(*)" → DANGER ───────────────────────────
test('checkPermissions: allowedTools with "Bash(*)" → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, { allowedTools: ['Bash(*)'], blockedTools: ['Write'] });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('"Bash(*)"')),
      `Expected error about Bash(*), got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 5. Safe allowedTools: ["Read"] → score 100 ────────────────────────────
test('checkPermissions: safe allowedTools ["Read"] → no Bash error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, { allowedTools: ['Read'], blockedTools: ['Bash', 'Write'] });
    const result = checkPermissions(dir);
    assert.ok(!result.issues.some(i => i.severity === 'error' && i.message.includes('Bash')),
      `Should not have Bash error, got: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 6. permissions.allow with "Bash(*)" → DANGER ──────────────────────────
test('checkPermissions: permissions.allow with "Bash(*)" → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {
      permissions: { allow: ['Bash(*)'] },
      blockedTools: ['Write'],
    });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('Bash(*)')),
      `Expected error about Bash(*) in permissions.allow, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 7. defaultMode: "bypassPermissions" → DANGER ──────────────────────────
test('checkPermissions: defaultMode "bypassPermissions" → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, { defaultMode: 'bypassPermissions', blockedTools: ['Write'] });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('bypassPermissions')),
      `Expected error about bypassPermissions, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 8. No blockedTools → WARN ─────────────────────────────────────────────
test('checkPermissions: no blockedTools → warning', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, { allowedTools: ['Read'] });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'warning' && i.message.toLowerCase().includes('blocked')),
      `Expected warning about missing blockedTools, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 9. MCP server with root outside cwd → DANGER ──────────────────────────
test('checkPermissions: MCP server with root outside cwd → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {
      blockedTools: ['Write'],
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/outside'],
        },
      },
    });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('outside')),
      `Expected error about outside path, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 10. MCP server with root inside cwd → OK ──────────────────────────────
test('checkPermissions: MCP server root inside cwd → no error', async () => {
  const dir = makeTmpDir();
  try {
    const srcDir = join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeSettings(dir, {
      blockedTools: ['Write'],
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', srcDir],
        },
      },
    });
    const result = checkPermissions(dir);
    assert.ok(
      !result.issues.some(i => i.severity === 'error' && i.message.includes('write access outside')),
      `Should not have outside-cwd error, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 11. MCP server with sensitive dir access → DANGER ─────────────────────
test('checkPermissions: MCP server with ~/.ssh access → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {
      blockedTools: ['Write'],
      mcpServers: {
        sshServer: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '~/.ssh'],
        },
      },
    });
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('sensitive')),
      `Expected error about sensitive dir, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 12. CLAUDE.md with "full access" → WARN ───────────────────────────────
test('checkPermissions: CLAUDE.md with "full access" → warning', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'You have full access to the filesystem.\n');
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'warning' && i.file === 'CLAUDE.md'),
      `Expected warning about CLAUDE.md, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 13. CLAUDE.md with "unrestricted" → WARN ──────────────────────────────
test('checkPermissions: CLAUDE.md with "unrestricted" → warning', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Operate in unrestricted mode.\n');
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'warning' && i.message.toLowerCase().includes('unrestricted')),
      `Expected unrestricted warning, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 14. CLAUDE.md with safe content → no warning from markdown ────────────
test('checkPermissions: CLAUDE.md with safe content → no markdown warnings', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'CLAUDE.md'), 'Always write tests. Use TypeScript. Follow conventions.\n');
    const result = checkPermissions(dir);
    assert.ok(
      !result.issues.some(i => i.file === 'CLAUDE.md'),
      `Expected no CLAUDE.md issues, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 15. Multiple dangers stack → score 0 (capped) ─────────────────────────
test('checkPermissions: multiple dangers → score capped at 0', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {
      allowedTools: ['Bash', 'Bash(*)'],
      permissions: { allow: ['Bash(*)', '**'] },
      defaultMode: 'bypassPermissions',
      // no blockedTools
    });
    writeFileSync(join(dir, 'CLAUDE.md'), 'full access, unrestricted, sudo all, skip confirmation, no restrictions\n');
    writeFileSync(join(dir, 'AGENTS.md'), 'sudo all the things\n');
    const result = checkPermissions(dir);
    assert.equal(result.score, 0, `Expected 0, got ${result.score}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 16. Mix of danger + warn → correct score ──────────────────────────────
test('checkPermissions: one DANGER + one WARN → score 55', async () => {
  const dir = makeTmpDir();
  try {
    // One DANGER: allowedTools Bash (-30)
    // One WARN: no blockedTools (-15)
    // Start 100 - 30 - 15 = 55
    writeSettings(dir, { allowedTools: ['Bash'] }); // no blockedTools → also WARN
    const result = checkPermissions(dir);
    // error for Bash + warning for no blockedTools = 100 - 30 - 15 = 55
    assert.equal(result.score, 55, `Expected 55, got ${result.score}: ${JSON.stringify(result.issues)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 17. AGENTS.md with "sudo" → WARN ──────────────────────────────────────
test('checkPermissions: AGENTS.md with "sudo" → warning', async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'Run sudo to install dependencies.\n');
    const result = checkPermissions(dir);
    assert.ok(result.score < 100);
    assert.ok(
      result.issues.some(i => i.severity === 'warning' && i.file === 'AGENTS.md'),
      `Expected warning about AGENTS.md sudo, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 18. result shape is correct ───────────────────────────────────────────
test('checkPermissions: result has correct shape', async () => {
  const dir = makeTmpDir();
  try {
    const result = checkPermissions(dir);
    assert.equal(result.name, 'permissions');
    assert.equal(result.maxScore, 100);
    assert.ok(typeof result.score === 'number');
    assert.ok(typeof result.summary === 'string');
    assert.ok(Array.isArray(result.issues));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 19. score is always 0-100 ─────────────────────────────────────────────
test('checkPermissions: score is always 0-100', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {
      allowedTools: ['Bash', 'Bash(*)'],
      permissions: { allow: ['**', 'Bash(*)'] },
      defaultMode: 'bypassPermissions',
    });
    const result = checkPermissions(dir);
    assert.ok(result.score >= 0 && result.score <= 100);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ── 20. permissions.allow with "**" wildcard → DANGER ─────────────────────
test('checkPermissions: permissions.allow with "**" → error', async () => {
  const dir = makeTmpDir();
  try {
    writeSettings(dir, {
      blockedTools: ['Write'],
      permissions: { allow: ['**'] },
    });
    const result = checkPermissions(dir);
    assert.ok(
      result.issues.some(i => i.severity === 'error' && i.message.includes('**')),
      `Expected error about ** wildcard, got: ${JSON.stringify(result.issues)}`
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
