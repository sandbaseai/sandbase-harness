/**
 * The SDK's SSE reader against a server that sends keepalives.
 *
 * A long-lived stream is kept alive with a `ping` frame; older servers sent
 * `heartbeat`. Neither is a session event, and a caller iterating `tail()` must
 * not see one: the CLI prints every yielded event, so a keepalive reaching the
 * iterator would print a bogus `ping` every 15 seconds.
 *
 * The server here is a bare HTTP server rather than the runtime, so the frames
 * under test are exactly the ones written below.
 */

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ManagedAgentsClient } from '@/sdk/client.js';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

async function serveFrames(frames: string[]): Promise<string> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) res.write(frame);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('SDK event stream keepalives', () => {
  it('yields session events and skips every keepalive frame', async () => {
    const baseUrl = await serveFrames([
      // The runtime's current keepalive, an older server's keepalive, and a
      // keepalive with no payload at all.
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: heartbeat\ndata: \n\n',
      'event: ping\ndata: \n\n',
      'id: 1\nevent: user.message\ndata: {"id":"sevt_1","seq":1,"type":"user.message"}\n\n',
      'id: 2\nevent: agent.message\ndata: {"id":"sevt_2","seq":2,"type":"agent.message"}\n\n',
    ]);
    const client = new ManagedAgentsClient({ baseUrl });

    const received: Array<{ type?: string; seq?: number }> = [];
    for await (const event of client.sessions.tail('sess_keepalive')) {
      received.push(event as { type?: string; seq?: number });
    }

    expect(received).toEqual([
      { id: 'sevt_1', seq: 1, type: 'user.message' },
      { id: 'sevt_2', seq: 2, type: 'agent.message' },
    ]);
  });
});
