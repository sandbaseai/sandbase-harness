/**
 * Runs every enabled docs-example page against a real Anthropic model and
 * writes a summary to `docs/test-evidence/live-docs-examples-<date>.md`.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node --import tsx scripts/docs-examples-live.mjs
 *
 * Optional: `DOCS_EXAMPLES_LIVE_MODEL` overrides the default model id
 * (claude-sonnet-4-6), and `DOCS_EXAMPLES_LIVE_BASE_URL` points the provider
 * at an Anthropic-compatible endpoint (relay, gateway, proxy). The key comes
 * from the operator's environment and is never printed or written to the
 * evidence file; a custom base URL is recorded in it.
 *
 * The example code is identical to what `npm run test:docs-examples` executes
 * — the only difference is the provider: this script starts the runtime with
 * `model.provider: anthropic` and the operator's key instead of the stub model
 * server. Per page it records the example's exit code, wall time, and the
 * session summary (usage buckets including cache read/write, final status,
 * stop_reason) — never request bodies or reply text, so the evidence file is
 * safe to commit.
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { renderDocsExampleScript } from '../tests/conformance/docs-examples/harness.js';
import { docsExamplePages } from '../tests/conformance/docs-examples/manifest.js';
import { loadDocsExampleSource } from '../tests/conformance/docs-examples/source.js';
import { startRuntimeHarness } from '../tests/conformance/support/runtime-server.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.DOCS_EXAMPLES_LIVE_MODEL ?? 'claude-sonnet-4-6';
// Optional Anthropic-compatible endpoint override (relay, gateway, proxy).
// Recorded in the evidence file so a run against a non-default endpoint is
// identifiable as such rather than implied to be api.anthropic.com.
const BASE_URL = process.env.DOCS_EXAMPLES_LIVE_BASE_URL;
const SCRIPT_TIMEOUT_MS = 120_000;

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set. Set it locally — it is used to configure the runtime and is never recorded.');
  process.exit(2);
}

function executeScript(scriptPath, baseUrl) {
  const {
    ANTHROPIC_API_KEY: _key,
    ANTHROPIC_AUTH_TOKEN: _token,
    RUNTIME_BASE_URL: _url,
    RUNTIME_API_KEY: _clientKey,
    ...inherited
  } = process.env;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: repositoryRoot,
      env: { ...inherited, RUNTIME_BASE_URL: baseUrl, RUNTIME_API_KEY: 'conformance-stub-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderrTail = '';
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new Error(`example did not exit within ${SCRIPT_TIMEOUT_MS}ms`));
    }, SCRIPT_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stderrTail });
    });
  });
}

async function latestSessionEvidence(baseUrl) {
  const list = await (await fetch(`${baseUrl}/v1/sessions?order=desc`)).json();
  const session = list.data?.[0];
  if (!session) return {};
  const detail = await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json();
  const usage = detail.usage ?? {};
  // The last status event carries the terminal stop_reason when there is one.
  const events = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?order=desc`)).json();
  const statusEvent = (events.data ?? []).find((event) => event.type.startsWith('session.status_'));
  return {
    sessionId: session.id,
    status: detail.status,
    stopReason: statusEvent?.stop_reason?.type ?? '',
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  };
}

async function runPage(page) {
  const source = loadDocsExampleSource(page);
  // Fixture agents must name a real Anthropic model in a live run; the stub
  // suite's placeholder id would fail provider admission.
  const script = renderDocsExampleScript(page, source.text, MODEL);
  const scriptDir = mkdtempSync(join(tmpdir(), 'docs-example-live-'));
  const scriptPath = join(scriptDir, 'example.mts');
  writeFileSync(scriptPath, script, 'utf8');
  const runtime = await startRuntimeHarness({
    provider: 'anthropic',
    apiKey,
    model: MODEL,
    ...(BASE_URL ? { modelBaseUrl: BASE_URL } : {}),
  });
  const startedAt = Date.now();
  try {
    const result = await executeScript(scriptPath, runtime.baseUrl);
    const evidence = result.code === 0 ? await latestSessionEvidence(runtime.baseUrl) : {};
    return {
      page: page.id,
      code: result.code ?? 'signal',
      elapsedSeconds: ((Date.now() - startedAt) / 1000).toFixed(1),
      errorTail: result.code === 0 ? '' : result.stderrTail,
      ...evidence,
    };
  } catch (error) {
    return {
      page: page.id,
      code: 'error',
      elapsedSeconds: ((Date.now() - startedAt) / 1000).toFixed(1),
      errorTail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.stop();
    rmSync(scriptDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function sdkVersion() {
  try {
    return JSON.parse(readFileSync(join(repositoryRoot, 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function commitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repositoryRoot }).toString().trim();
  } catch {
    return 'unknown';
  }
}

const enabled = docsExamplePages.filter((page) => page.status === 'enabled');
console.log(`Running ${enabled.length} enabled docs examples against Anthropic (${MODEL}).`);

const rows = [];
for (const page of enabled) {
  process.stdout.write(`  ${page.id} … `);
  const row = await runPage(page);
  console.log(`${row.code} in ${row.elapsedSeconds}s`);
  if (row.errorTail) console.log(`    ${row.errorTail.split('\n').filter(Boolean).pop()}`);
  rows.push(row);
}

const date = new Date().toISOString().slice(0, 10);
const outDir = join(repositoryRoot, 'docs', 'test-evidence');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `live-docs-examples-${date}.md`);

const lines = [
  `# Live docs-example validation — ${date}`,
  '',
  `Environment: Node ${process.version}, @anthropic-ai/sdk ${sdkVersion()}, runtime commit ${commitSha()}, model \`${MODEL}\`.`,
  `Model endpoint: ${BASE_URL ? `\`${BASE_URL}\` (custom \`DOCS_EXAMPLES_LIVE_BASE_URL\`)` : 'the provider default (api.anthropic.com)'}.`,
  '',
  'Each enabled docs-example page ran unchanged against a locally started runtime',
  'configured with the operator\'s `ANTHROPIC_API_KEY` and the real Anthropic',
  'provider. This file records outcome summaries only — exit code, duration,',
  'session usage buckets (including prompt-cache reads/writes), final status,',
  'and the last stop_reason. No keys, request bodies, or model replies are',
  'recorded.',
  '',
  '| Page | Exit | Duration | Session | Input | Output | Cache read | Cache write | Final status | Stop reason |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((row) =>
    `| ${row.page} | ${row.code} | ${row.elapsedSeconds}s | ${row.sessionId ?? '—'} | ${row.inputTokens ?? '—'} | ${row.outputTokens ?? '—'} | ${row.cacheRead ?? '—'} | ${row.cacheWrite ?? '—'} | ${row.status ?? '—'} | ${row.stopReason ?? '—'} |`,
  ),
  '',
];

writeFileSync(outPath, lines.join('\n'));
console.log(`\nEvidence written to ${outPath}`);
