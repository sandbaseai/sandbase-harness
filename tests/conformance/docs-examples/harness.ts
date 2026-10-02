import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import type { DocsExamplePage, DocsExampleReplacement } from './manifest.js';
import { loadDocsExampleSource, type DocsExampleSource } from './source.js';
import { startRuntimeHarness, type RunningRuntime } from '../support/runtime-server.js';
import { startStubModelServer } from '../support/stub-model-server.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface DocsExampleRun {
  code: number | null;
  stdout: string;
  stderr: string;
  runtimeOutput: string;
  source: DocsExampleSource;
}

export async function runDocsExample(page: DocsExamplePage): Promise<DocsExampleRun> {
  const source = loadDocsExampleSource(page);
  const script = renderDocsExampleScript(page, source.text);
  const scriptRoot = mkdtempSync(join(repositoryRoot, 'tests', 'conformance', '.docs-example-'));
  const scriptPath = join(scriptRoot, 'example.mts');
  let runtime: RunningRuntime | undefined;
  let stub: Awaited<ReturnType<typeof startStubModelServer>> | undefined;

  try {
    stub = await startStubModelServer(page.model);
    writeFileSync(scriptPath, script, 'utf8');
    runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl, model: 'claude-opus-5' });
    const result = await executeScript(scriptPath, runtime.baseUrl);
    return { ...result, runtimeOutput: runtime.output(), source };
  } finally {
    try {
      if (runtime) await runtime.stop();
    } finally {
      try {
        if (stub) await stub.close();
      } finally {
        rmSync(scriptRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
}

export function renderDocsExampleScript(page: DocsExamplePage, source: string): string {
  const replaced = stripClientBootstrap(applyReplacements(source, page.replacements ?? []));
  const prelude = [
    'import Anthropic from "@anthropic-ai/sdk";',
    'const client = new Anthropic({ baseURL: process.env.RUNTIME_BASE_URL!, apiKey: process.env.RUNTIME_API_KEY!, authToken: null, maxRetries: 0, timeout: 30_000 });',
  ];

  for (const fixture of page.fixtures ?? []) {
    if (fixture === 'agent') {
      prelude.push('const fixtureAgent = await client.beta.agents.create({ name: "docs-example-fixture", model: "claude-opus-5" });');
    } else if (fixture === 'environment') {
      prelude.push('const fixtureEnvironment = await client.beta.environments.create({ name: "docs-example-fixture", config: { type: "local" } });');
    } else {
      throw new Error(`Unsupported docs example fixture: ${fixture}`);
    }
  }

  return `${prelude.join('\n')}\n\n${replaced}\n`;
}

function stripClientBootstrap(source: string): string {
  const parsed = parse(source, { sourceType: 'module', plugins: ['typescript'] });
  let cursor = 0;
  let result = '';
  for (const statement of parsed.program.body) {
    const isSdkImport = statement.type === 'ImportDeclaration'
      && statement.source.value === '@anthropic-ai/sdk'
      && statement.specifiers.length === 1
      && statement.specifiers[0].type === 'ImportDefaultSpecifier'
      && statement.specifiers[0].local.name === 'Anthropic';
    const declaration = statement.type === 'VariableDeclaration' && statement.declarations.length === 1
      ? statement.declarations[0] : undefined;
    const isClient = declaration?.id.type === 'Identifier' && declaration.id.name === 'client'
      && declaration.init?.type === 'NewExpression'
      && declaration.init.callee.type === 'Identifier' && declaration.init.callee.name === 'Anthropic';
    if (isSdkImport || isClient) {
      result += source.slice(cursor, statement.start!);
      cursor = statement.end!;
    }
  }
  return `${result}${source.slice(cursor)}`.trim();
}

function applyReplacements(source: string, replacements: DocsExampleReplacement[]): string {
  let result = source;
  for (const replacement of replacements) {
    const pattern = typeof replacement.from === 'string'
      ? replacement.from : new RegExp(replacement.from.source, replacement.from.flags);
    const matches = typeof pattern === 'string' ? result.includes(pattern) : pattern.test(result);
    if (!matches) throw new Error(`Docs example replacement did not match: ${replacement.from}\nReason: ${replacement.why}`);
    if (typeof pattern === 'string') {
      result = result.replaceAll(pattern, replacement.to);
    } else {
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement.to);
    }
  }
  return result;
}

async function executeScript(scriptPath: string, baseUrl: string): Promise<Omit<DocsExampleRun, 'runtimeOutput' | 'source'>> {
  const {
    ANTHROPIC_API_KEY: _anthropicKey,
    ANTHROPIC_AUTH_TOKEN: _anthropicToken,
    RUNTIME_BASE_URL: _baseUrl,
    RUNTIME_API_KEY: _apiKey,
    ...inherited
  } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
    cwd: repositoryRoot,
    env: { ...inherited, RUNTIME_BASE_URL: baseUrl, RUNTIME_API_KEY: 'conformance-stub-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut) rejectExit(new Error(`Docs example did not exit within 60s\n${stdout}\n${stderr}`));
      else resolveExit(exitCode);
    });
  });
  return { code, stdout, stderr };
}
