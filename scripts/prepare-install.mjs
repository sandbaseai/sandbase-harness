import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeEntry = join(root, 'dist', 'index.js');
const mcpEntry = join(root, 'dist', 'mcp', 'index.js');

if (existsSync(runtimeEntry) && existsSync(mcpEntry)) {
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
