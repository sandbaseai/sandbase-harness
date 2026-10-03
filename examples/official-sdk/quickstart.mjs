#!/usr/bin/env node
/**
 * The official Anthropic TypeScript SDK against a local SandBase Harness
 * runtime — the quickstart, with nothing changed but where it points.
 *
 * Every call below is the published SDK's own API, and every request is the
 * published shape — including the environment's `config.type: "cloud"`, which
 * this runtime serves from the workspace's configured sandbox backend (see
 * `docs/api.md`, "Environments"). The only lines that differ from a quickstart
 * written against the hosted service are `baseURL` and the credential. No
 * request is hand-rolled and no response is reshaped: if this script reads a
 * reply, an official client can talk to this runtime.
 *
 * Usage
 *
 *   1. Start a runtime and give it a model provider, following the repository
 *      Quick Start (`dist/index.js init`, then `dist/index.js start`), then
 *      configure a provider in Settings > Setup. See the README beside this
 *      file for the exact commands.
 *   2. Run this script, pointing at the runtime:
 *        ANTHROPIC_BASE_URL=http://127.0.0.1:3000 ANTHROPIC_API_KEY=local \
 *          node <clone>/examples/official-sdk/quickstart.mjs "Say hello in one sentence."
 *
 * Set exactly one credential variable. `ANTHROPIC_API_KEY` becomes the SDK's
 * `x-api-key` header and `ANTHROPIC_AUTH_TOKEN` becomes `Authorization: Bearer`;
 * sending both is refused with `401 authentication_error` — by design, because
 * two competing credential sources must fail closed rather than have the server
 * pick one. If your runtime has no API key configured, any non-empty value works.
 *
 * Add `--json` to print one JSON object per event instead of human-readable
 * lines. The conformance suite drives this script that way, so the example is
 * executed by CI rather than merely documented.
 */

import Anthropic from '@anthropic-ai/sdk';

const jsonMode = process.argv.includes('--json');
const prompt = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  ?? 'Say hello in one short sentence, then use a tool to look at the workspace.';

const apiKey = process.env.ANTHROPIC_API_KEY;
const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (apiKey && authToken) {
  fail('Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, not both: this runtime refuses a request that carries two credential sources (401).');
}
if (!apiKey && !authToken) {
  fail('Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) to any non-empty value. It is the key this runtime was started with, if it has one.');
}

const baseURL = process.env.ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:3000';
const client = new Anthropic({ baseURL });

/** Print one line, as prose or as JSON, so both a reader and CI can consume it. */
function report(type, payload = {}) {
  if (jsonMode) console.log(JSON.stringify({ type, ...payload }));
  else console.log(payload.text !== undefined ? `${type}: ${payload.text}` : `${type}: ${JSON.stringify(payload)}`);
}

function fail(message, code = 1) {
  if (jsonMode) console.log(JSON.stringify({ type: 'error', message }));
  else console.error(`error: ${message}`);
  process.exit(code);
}

const transcript = { messages: [], toolUses: [], stopReason: undefined };

try {
  report('base_url', { text: baseURL });

  // 1. An agent: a name, a model id the configured provider serves, and the
  //    tools it may use. `glob` is allowed outright so the turn needs no human.
  const agent = await client.beta.agents.create({
    name: 'official-sdk-quickstart',
    model: process.env.QUICKSTART_MODEL ?? 'gpt-4o',
    system: 'You are a concise assistant. Use the glob tool once, then answer.',
    tools: [{
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [{ name: 'glob', enabled: true, permission_policy: { type: 'always_allow' } }],
    }],
  });
  report('agent', { text: agent.id });

  // 2. An environment — the exact shape the published quickstart sends.
  //    `cloud` means "the platform decides"; on this runtime the platform is
  //    the workspace, so sessions provision the workspace's configured sandbox
  //    backend, reported back as `effective_sandbox_provider`.
  const environment = await client.beta.environments.create({
    name: 'official-sdk-quickstart',
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
  });
  report('environment', { text: environment.id });

  // 3. A session binds the two.
  const session = await client.beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
  });
  report('session', { text: `${session.id} (${session.status})` });

  // 4. Open the event stream before sending, so the turn's events are read as
  //    they happen. A stream with no cursor carries live events only.
  const stream = await client.beta.sessions.events.stream(session.id);
  try {
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
    });

    for await (const event of withTimeout(stream, 120_000)) {
      if (event.type === 'agent.message') {
        const text = (event.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        transcript.messages.push(text);
        report('agent.message', { text });
      } else if (event.type === 'agent.tool_use') {
        const use = event.content?.[0];
        transcript.toolUses.push({ name: use?.name, input: use?.input });
        report('agent.tool_use', { text: `${use?.name} ${JSON.stringify(use?.input ?? {})}` });
      } else if (event.type === 'agent.tool_result') {
        report('agent.tool_result', { text: 'received' });
      } else if (event.type === 'session.status_idle') {
        transcript.stopReason = event.stop_reason?.type;
        report('session.status_idle', { text: `stop_reason=${transcript.stopReason}` });
        break;
      }
    }
  } finally {
    stream.controller.abort();
  }

  // 5. Read the session back: the same state the stream just announced.
  const final = await client.beta.sessions.retrieve(session.id);
  report('session.retrieve', { text: `${final.status} usage=${JSON.stringify(final.usage ?? {})}` });

  if (transcript.messages.length === 0) fail('the turn produced no agent.message', 2);
  if (!transcript.stopReason) fail('the session never reached session.status_idle', 3);
  report('done', { text: `${transcript.messages.length} message(s), ${transcript.toolUses.length} tool call(s)` });
} catch (error) {
  fail(error?.message ?? String(error));
}

/**
 * Iterate a stream, aborting it if the turn does not finish in time: a
 * quickstart that hangs forever teaches nothing about what went wrong.
 */
async function* withTimeout(stream, ms) {
  const timer = setTimeout(() => stream.controller.abort(), ms);
  try {
    for await (const event of stream) yield event;
  } finally {
    clearTimeout(timer);
  }
}
