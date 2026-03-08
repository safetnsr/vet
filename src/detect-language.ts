import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ProjectLanguage = 'javascript' | 'typescript' | 'python' | 'unknown';

/**
 * Detect the primary language of a project by checking for marker files.
 * Priority: typescript > javascript > python > unknown
 */
export function detectProjectLanguage(cwd: string): ProjectLanguage {
  // TypeScript markers
  if (existsSync(join(cwd, 'tsconfig.json'))) return 'typescript';

  // JavaScript/TypeScript (package.json present)
  if (existsSync(join(cwd, 'package.json'))) {
    // Check if any tsconfig variant exists
    const tsConfigs = ['tsconfig.build.json', 'tsconfig.app.json', 'tsconfig.node.json'];
    if (tsConfigs.some(f => existsSync(join(cwd, f)))) return 'typescript';
    return 'javascript';
  }

  // Python markers
  const pythonMarkers = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'];
  if (pythonMarkers.some(f => existsSync(join(cwd, f)))) return 'python';

  return 'unknown';
}
