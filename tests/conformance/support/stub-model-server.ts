/**
 * A model provider the conformance suite starts itself, for the tests that need
 * a turn to actually run.
 *
 * `tests/conformance` is otherwise a shape-layer suite: it asserts what the API
 * answers without a model, which is why its shared driver deliberately
 * configures none. The official-SDK quickstart cannot be checked that way — a
 * quickstart that never reaches `agent.message` proves the endpoints exist, not
 * that an official client can drive a turn — so this file supplies the smallest
 * provider that can produce one: an OpenAI-compatible `/v1/chat/completions`
 * endpoint that answers with a tool call, then with text, then stops.
 *
 * It is registered by the *test* and only by the test: a workspace config names
 * this server's URL as its provider base URL, and nothing under `src/` knows it
 * exists. That is the whole of its relationship to the runtime (D28) — a stub
 * model is a test fixture, never a provider a user can select, so it is not in
 * Settings, not in the CLI, and not in the docs. If a user could choose it, the
 * no-key experience it offers would be a capability this project does not have.
 *
 * The reply is deliberately the shape a real OpenAI-compatible provider sends,
 * including split `tool_calls` argument fragments and a trailing usage chunk,
 * because those are the parts of the wire format the runtime has to assemble
 * correctly for the turn to reach a terminal state.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The text the second (post-tool) turn answers with, so a test can assert it. */
export const STUB_REPLY_TEXT = 'Hello from the SandBase Harness conformance model.';

/** Tools the stub will call, in preference order, when the runtime offers them. */
const TOOL_PREFERENCE = ['glob', 'read', 'bash'] as const;

/** Arguments per preferred tool, so the call is valid for the tool it names. */
const TOOL_ARGUMENTS: Record<string, unknown> = {
  glob: { pattern: '*' },
  read: { path: 'README.md' },
  bash: { command: 'echo conformance' },
};

interface ChatMessage {
  role?: string;
  content?: unknown;
}

interface ChatTool {
  type?: string;
  function?: { name?: string };
}

export interface StubModelRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: ChatTool[];
}

export interface StubModelServer {
  /** Base URL to put in a workspace's provider config, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  /** Every request the runtime sent, in order, with its tool list and messages. */
  requests: StubModelRequest[];
  /** The tool the stub called in its first reply, once one has been issued. */
  calledTool?: string;
  close(): Promise<void>;
}

export async function startStubModelServer(): Promise<StubModelServer> {
  const requests: StubModelRequest[] = [];
  let calledTool: string | undefined;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no stub route for ${req.method} ${req.url}` } }));
      return;
    }
    void readJson(req).then((body) => {
      const request = body as StubModelRequest;
      requests.push(request);
      if (wantToolCall(request) && calledTool === undefined) {
        const tool = pickTool(request.tools);
        // Only the first reply calls a tool: the runtime then sends the result
        // back, and the second reply has to end the turn or the session never
        // reaches idle and the quickstart would hang instead of failing.
        if (tool) {
          calledTool = tool;
          respond(req, res, request, { tool, toolArguments: TOOL_ARGUMENTS[tool] ?? {} });
          return;
        }
      }
      respond(req, res, request, { text: STUB_REPLY_TEXT });
    }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  await listen(server);
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    get calledTool() {
      return calledTool;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** True while no tool result has come back yet: the tool-calling turn. */
function wantToolCall(request: StubModelRequest): boolean {
  return !(request.messages ?? []).some((message) => {
    if (message.role === 'tool') return true;
    return Array.isArray(message.content)
      && message.content.some((part) => {
        const type = (part as { type?: string } | null)?.type;
        return type === 'tool-result' || type === 'tool_result';
      });
  });
}

function pickTool(tools: ChatTool[] | undefined): string | undefined {
  const offered = new Set((tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  return TOOL_PREFERENCE.find((name) => offered.has(name));
}

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  request: StubModelRequest,
  reply: { text?: string; tool?: string; toolArguments?: unknown },
): void {
  const model = request.model ?? 'stub-model';
  const id = `chatcmpl-stub-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = 12;
  const completionTokens = 7;

  if (!request.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: reply.tool
          ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_stub_1',
              type: 'function',
              function: { name: reply.tool, arguments: JSON.stringify(reply.toolArguments ?? {}) },
            }],
          }
          : { role: 'assistant', content: reply.text ?? '' },
        finish_reason: reply.tool ? 'tool_calls' : 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta: unknown, finishReason: string | null = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
  };

  chunk({ role: 'assistant', content: '' });
  if (reply.tool) {
    // Split the argument object across fragments: a provider is allowed to, and
    // the runtime has to reassemble it before the tool call is executable.
    const args = JSON.stringify(reply.toolArguments ?? {});
    const cut = Math.max(1, Math.floor(args.length / 2));
    chunk({
      tool_calls: [{
        index: 0,
        id: 'call_stub_1',
        type: 'function',
        function: { name: reply.tool, arguments: '' },
      }],
    });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, cut) } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] });
    chunk({}, 'tool_calls');
  } else {
    const text = reply.text ?? '';
    const cut = Math.max(1, Math.floor(text.length / 2));
    chunk({ content: text.slice(0, cut) });
    chunk({ content: text.slice(cut) });
    chunk({}, 'stop');
  }
  // The trailing usage chunk carries no choices, which is how an OpenAI-style
  // stream reports usage for the whole completion.
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : {};
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}
