import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run through npm run smoke:dsh-profile');
const scratch = await mkdtemp(join(tmpdir(), 'dsh profile smoke '));
const expectedTools = ['list_agents', 'create_session', 'run_session', 'get_session', 'list_artifacts', 'stop_session'].sort();

function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd, encoding: 'utf8', timeout: 180_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  // Test the packaged artifact with scripts disabled: its build must be complete.
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', scratch], root));
  const installed = join(scratch, 'installed');
  await mkdir(installed);
  npm(['install', '--prefix', installed, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    join(scratch, packed.filename)], scratch);
  const packageRoot = join(installed, 'node_modules', 'managed-agents');
  const patch = parse(await readFile(join(packageRoot, 'examples/deepseek-harness/cordis.yml'), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
  });
  const config = patch[0].insert[0].config;

  for (const name of ['web', 'desktop', 'custom-profile']) {
    const dir = join(scratch, 'profiles with spaces', name);
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    // Junctions work on Windows without privileged symbolic-link creation.
    await symlink(packageRoot, join(dir, 'node_modules', 'managed-agents'), 'junction');
    const scope = { profileContext: { name, dir }, process: { env: {} } };
    const args = config.args.map((expression) => runInNewContext(expression, scope));
    const env = Object.fromEntries(Object.entries(config.env).map(([key, expression]) => [key, runInNewContext(expression, scope)]));
    assert.equal(config.command, 'node');
    assert.equal(config.transport, 'stdio');
    assert.equal(args.length, 1);
    assert.equal(env.MANAGED_AGENTS_URL, 'http://127.0.0.1:3000');
    assert.equal(env.MANAGED_AGENTS_API_KEY, '');
    assert.equal(resolve(args[0]), join(dir, 'node_modules', 'managed-agents', 'dist', 'mcp', 'index.js'));
    const client = new Client({ name: 'dsh-profile-smoke', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: config.command, args, env, stderr: 'pipe' });
    try {
      await client.connect(transport, { timeout: 15_000 });
      const result = await client.listTools(undefined, { timeout: 15_000 });
      assert.deepEqual(result.tools.map((tool) => tool.name).sort(), expectedTools);
      console.log(`${name}: packaged MCP initialized and listed all six tools`);
    } finally {
      await client.close();
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
