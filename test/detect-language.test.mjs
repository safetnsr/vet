import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { detectProjectLanguage } = await import('../src/detect-language.ts');

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'vet-lang-'));
}

describe('detectProjectLanguage', () => {
  test('tsconfig.json → typescript', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      assert.equal(detectProjectLanguage(dir), 'typescript');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('package.json only → javascript', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      assert.equal(detectProjectLanguage(dir), 'javascript');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('package.json + tsconfig.build.json → typescript', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'package.json'), '{}');
      writeFileSync(join(dir, 'tsconfig.build.json'), '{}');
      assert.equal(detectProjectLanguage(dir), 'typescript');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('pyproject.toml → python', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'pyproject.toml'), '[project]');
      assert.equal(detectProjectLanguage(dir), 'python');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('setup.py → python', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'setup.py'), 'from setuptools import setup');
      assert.equal(detectProjectLanguage(dir), 'python');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('requirements.txt → python', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'requirements.txt'), 'flask==2.0');
      assert.equal(detectProjectLanguage(dir), 'python');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('empty dir → unknown', () => {
    const dir = makeTmpDir();
    try {
      assert.equal(detectProjectLanguage(dir), 'unknown');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('tsconfig.json takes priority over pyproject.toml', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      writeFileSync(join(dir, 'pyproject.toml'), '[project]');
      assert.equal(detectProjectLanguage(dir), 'typescript');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
