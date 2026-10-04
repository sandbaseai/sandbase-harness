/**
 * The Console's "Equivalent request" panel promises that the TypeScript tab is
 * code a developer can paste and run. This test keeps that true by executing
 * the generated snippet against a real runtime, the same way the docs-example
 * suite executes the snippets the documentation ships.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { equivalentSnippet } from '../../apps/console/src/lib/equivalentRequest.js';
import { startRuntimeHarness } from '../conformance/support/runtime-server.js';
import { startStubModelServer } from '../conformance/support/stub-model-server.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('the generated equivalent-request snippet', () => {
  it('executes against a real runtime and creates the agent', async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    const scriptRoot = mkdtempSync(join(repositoryRoot, 'tests', 'integration', '.equivalent-request-'));

    try {
      const snippet = equivalentSnippet(
        { method: 'POST', path: '/v1/agents', body: { name: 'snippet-agent', model: 'conformance-model' } },
        runtime.baseUrl,
        'typescript',
      );
      const scriptPath = join(scriptRoot, 'snippet.mts');
      writeFileSync(scriptPath, snippet, 'utf8');

      const result = await runScript(scriptPath);
      expect(result.stderr).toBe('');
      expect(result.code, `${result.stdout}\n${result.stderr}\n--- runtime ---\n${runtime.output()}`).toBe(0);
      expect(result.stdout).toMatch(/^agent_/);

      const agents = await fetch(`${runtime.baseUrl}/v1/agents`).then((res) => res.json()) as { data?: Array<{ name: string }> };
      expect(agents.data?.some((agent) => agent.name === 'snippet-agent')).toBe(true);
    } finally {
      await runtime.stop();
      await stub.close();
      rmSync(scriptRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

async function runScript(scriptPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { ANTHROPIC_AUTH_TOKEN: _token, ...inherited } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: repositoryRoot,
    env: { ...inherited, ANTHROPIC_API_KEY: 'snippet-test-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`snippet did not exit within 60s\n${stdout}\n${stderr}`));
    }, 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timer); resolveExit(exitCode); });
  });
  return { code, stdout, stderr };
}
