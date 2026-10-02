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
  'mcp-oauth-validation', 'The runtime has no MCP OAuth refresh or validation service.',
);

export function unsupportedOfficialRoutes(): Hono {
  const app = new Hono();
  const dreams = rejectCapability('dreams', 'The memory-consolidation pipeline is not implemented in this phase.');
  const tunnels = rejectCapability('mcp-tunnel', 'MCP tunnels require hosted connectivity outside the local-first scope.');
  const profiles = rejectCapability('user-profiles', 'Hosted user profile management is outside the single-tenant runtime scope.');
  const work = rejectCapability('environment-work', 'The hosted Work API is not the local worker queue API.');

  app.get('/dreams', dreams);
  app.post('/dreams', dreams);
  app.get('/dreams/:id', dreams);
  app.post('/dreams/:id/archive', dreams);
  app.post('/dreams/:id/cancel', dreams);

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

  app.get('/environments/:id/work', work);
  app.get('/environments/:id/work/poll', work);
  app.get('/environments/:id/work/stats', work);
  app.get('/environments/:id/work/:workId', work);
  app.post('/environments/:id/work/:workId', work);
  app.post('/environments/:id/work/:workId/ack', work);
  app.post('/environments/:id/work/:workId/heartbeat', work);
  app.post('/environments/:id/work/:workId/stop', work);

  return app;
}
