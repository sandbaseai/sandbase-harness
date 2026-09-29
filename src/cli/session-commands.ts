import { ManagedAgentsClient } from '@/sdk/client.js';

export type CliConnectionOptions = {
  port: string;
  apiKey?: string;
};

export type SessionCreateOptions = CliConnectionOptions & {
  agent?: string;
  environment?: string;
  title?: string;
};

export type SessionMessageOptions = CliConnectionOptions & {
  message: string;
  stream?: boolean;
};

export type SessionTailOptions = CliConnectionOptions & {
  lastEventId?: string;
};

export type SessionInspectOptions = CliConnectionOptions & {
  json?: boolean;
};

export async function sessionCreateCommand(opts: SessionCreateOptions) {
  const client = createClient(opts);
  const agent = opts.agent ?? await firstAgentId(client);
  const session = await client.sessions.create({
    agent,
    environment_id: opts.environment,
    title: opts.title,
  });
  console.log(session.id);
}

export async function sessionMessageCommand(sessionId: string, opts: SessionMessageOptions) {
  const client = createClient(opts);
  if (opts.stream === false) {
    await client.sessions.message(sessionId, opts.message, { stream: false });
    console.log('accepted');
    return;
  }
  for await (const event of client.sessions.message(sessionId, opts.message)) {
    printEvent(event);
  }
}

/**
 * Follow a session's event log.
 *
 * A stream opened without a cursor carries live events only, so the recorded log
 * is read first and the subscription then resumes after the last sequence that
 * was printed: nothing recorded is missed, and nothing printed twice. Passing
 * `--last-event-id` skips that read, because the caller has named where to
 * resume from.
 */
export async function sessionTailCommand(sessionId: string, opts: SessionTailOptions) {
  const client = createClient(opts);
  let resumeFrom = opts.lastEventId;
  if (resumeFrom === undefined) {
    const history = await client.sessions.events(sessionId, { limit: 1000 });
    for (const event of history.data) {
      printEvent(event);
    }
    resumeFrom = String(lastRecordedSeq(history.data));
  }
  for await (const event of client.sessions.tail(sessionId, { lastEventId: resumeFrom })) {
    printEvent(event);
  }
}

/** The highest recorded sequence in a page of events; 0 when there is none. */
function lastRecordedSeq(events: Array<{ seq?: number }>): number {
  let highest = 0;
  for (const event of events) {
    if (typeof event.seq === 'number' && event.seq > highest) highest = event.seq;
  }
  return highest;
}

export async function sessionInspectCommand(sessionId: string, opts: SessionInspectOptions) {
  const client = createClient(opts);
  const session = await client.sessions.get(sessionId);
  const events = await client.sessions.events(sessionId, { limit: 1000 });
  if (opts.json) {
    console.log(JSON.stringify({ session, events: events.data }, null, 2));
    return;
  }
  console.log(`${session.id}  ${session.status}  ${session.agent.name}`);
  console.log(`title: ${session.title ?? '-'}`);
  console.log(`events: ${events.data.length}`);
  console.log(`tokens: ${session.usage.input_tokens}/${session.usage.output_tokens}`);
}

export async function sessionLogsCommand(sessionId: string, opts: CliConnectionOptions) {
  const client = createClient(opts);
  const events = await client.sessions.events(sessionId, { limit: 1000 });
  for (const event of events.data) {
    printEvent(event);
  }
}

function createClient(opts: CliConnectionOptions) {
  return new ManagedAgentsClient({
    baseUrl: `http://localhost:${opts.port}`,
    apiKey: opts.apiKey,
  });
}

async function firstAgentId(client: ManagedAgentsClient) {
  const { data } = await client.agents.list();
  const first = data[0]?.id;
  if (!first) throw new Error('No agents loaded on the server.');
  return first;
}

function printEvent(event: { id?: string; type: string; delta?: string; content?: unknown }) {
  if (event.type === 'agent.message_chunk') {
    process.stdout.write(event.delta ?? '');
    return;
  }
  console.log(JSON.stringify(event));
}
