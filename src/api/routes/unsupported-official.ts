import { Hono, type Handler } from 'hono';

function rejectCapability(id: string, reason: string): Handler {
  return (context) => context.json({
    error: {
      type: 'unsupported_capability',
      message: 'This capability is not supported by SandBase Harness. See docs/api-matrix.md#unsupported-official-routes.',
      details: { capabilities: [{ id, reason }] },
    },
  }, 400);
}

export const unsupportedMcpOAuthValidation = rejectCapability(
  'mcp-oauth-validation', 'MCP OAuth tokens refresh at the injection boundary; a dedicated validation endpoint is not implemented.',
);

export function unsupportedOfficialRoutes(): Hono {
  const app = new Hono();
  const tunnels = rejectCapability('mcp-tunnel', 'MCP tunnels require hosted connectivity outside the local-first scope.');
  const profiles = rejectCapability('user-profiles', 'Hosted user profile management is outside the single-tenant runtime scope.');
  const work = rejectCapability('environment-work', 'The Work data plane is implemented; the management surface (list, stats, retrieve) is not yet.');
  const threads = rejectCapability(
    'threads-and-coordinator',
    'Session threads belong to the multiagent surface this runtime does not implement; a request reaches a mounted refusal rather than a 404.',
  );

  app.get('/tunnels', tunnels);
  app.post('/tunnels', tunnels);
  app.get('/tunnels/:id', tunnels);
  app.post('/tunnels/:id/archive', tunnels);
  app.post('/tunnels/:id/reveal_token', tunnels);
  app.post('/tunnels/:id/rotate_token', tunnels);
  app.get('/tunnels/:id/certificates', tunnels);
  app.post('/tunnels/:id/certificates', tunnels);
  app.get('/tunnels/:id/certificates/:certificateId', tunnels);
  app.post('/tunnels/:id/certificates/:certificateId/archive', tunnels);

  app.get('/user_profiles', profiles);
  app.post('/user_profiles', profiles);
  app.get('/user_profiles/:id', profiles);
  app.post('/user_profiles/:id', profiles);
  app.post('/user_profiles/:id/enrollment_url', profiles);

  app.get('/sessions/:id/threads', threads);
  app.get('/sessions/:id/threads/:threadId', threads);
  app.get('/sessions/:id/threads/:threadId/events', threads);
  app.get('/sessions/:id/threads/:threadId/stream', threads);
  app.post('/sessions/:id/threads/:threadId/archive', threads);

  // The Work data plane (poll/ack/heartbeat/update/stop) is implemented in
  // routes/environment-work.ts and mounts ahead of this router. The
  // management half — listing, single-item retrieve, and queue stats — is the
  // next slice and stays refused until it lands.
  app.get('/environments/:id/work', work);
  app.get('/environments/:id/work/stats', work);
  app.get('/environments/:id/work/:workId', work);

  return app;
}
