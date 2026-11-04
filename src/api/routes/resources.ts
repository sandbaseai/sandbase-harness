import { Hono } from 'hono';
import type { ServerDeps } from '../server.js';
import { credentialVaultRoutes } from './credential-vaults.js';
import { environmentRoutes } from './environments.js';
import { fileRoutes } from './files.js';
import { memoryStoreRoutes } from './memory-stores.js';

export function resourceRoutes(deps: ServerDeps) {
  const app = new Hono();

  app.route('/', environmentRoutes(deps));
  app.route('/', fileRoutes(deps));
  // Vaults answer under two prefixes, and both are the same routes: the published
  // `/v1/vaults*` the contract addresses them at, and the local
  // `/v1/credential-vaults*` the Console, the TypeScript SDK and existing stored
  // references use. That router declares its paths relative to its mount, so this
  // pair of mounts *is* the alias — there is no second route list to keep in step,
  // and a route added there is reachable at both prefixes with no edit here. The
  // local spelling keeps its credential_vault discriminator; the published
  // mount uses vault. All operations still share the same implementation.
  app.route('/credential-vaults', credentialVaultRoutes(deps));
  app.route('/vaults', credentialVaultRoutes(deps, 'vault'));
  app.route('/', memoryStoreRoutes(deps));

  return app;
}
