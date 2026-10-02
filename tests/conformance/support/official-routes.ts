import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { createServer } from '@/api/server.js';
import { CMA_AGENT_MEMORY_BETA, CMA_ANTHROPIC_VERSION, CMA_MANAGED_AGENTS_BETA, CMA_REFUSED_RESOURCE_BETAS } from '@/core/cma/compatibility.js';

export interface OfficialRoute {
  method: string;
  path: string;
}

const methods: Readonly<Record<string, string>> = {
  get: 'GET', getAPIList: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE',
};

export function extractOfficialRoutes(source: string): OfficialRoute[] {
  const routes: OfficialRoute[] = [];
  for (const call of source.matchAll(/this\._client\.([A-Za-z]+)\(\s*/g)) {
    if (call[1] === 'calculateNonstreamingTimeout') continue;
    const method = methods[call[1]];
    const argument = source.slice(call.index + call[0].length).match(/^(?:\(0,\s*path_\d+\.path\)\s*)?(['"`])([^'"`]+)\1/);
    if (!method || !argument) throw new Error(`Unrecognized SDK route call: ${call[0]}`);
    const path = argument[2].split('?')[0].replace(/\$\{[A-Za-z_$][\w$]*\}/g, ':id');
    if (!path.startsWith('/v1/') || path.includes('${')) {
      throw new Error(`Unrecognized SDK route path: ${argument[2]}`);
    }
    if (/^\/v1\/(?:messages|models|organizations?)(?:\/|$)/.test(path)) continue;
    routes.push({ method, path });
  }
  return routes;
}

export function loadOfficialRoutes(): OfficialRoute[] {
  const require = createRequire(import.meta.url);
  const root = join(dirname(require.resolve('@anthropic-ai/sdk')), 'resources', 'beta');
  const routes = new Map<string, OfficialRoute>();
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js') && basename(file) !== 'index.js').sort();
  for (const file of files) {
    for (const route of extractOfficialRoutes(readFileSync(join(root, file), 'utf8'))) {
      routes.set(routeKey(route), route);
    }
  }
  if (routes.size === 0) throw new Error('No managed-agent routes extracted from the installed official SDK');
  return [...routes.values()].sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
}

export function routeKey(route: OfficialRoute): string {
  return `${route.method} ${route.path}`;
}

export function mountedOfficialRoutes(app: ReturnType<typeof createServer>): Set<string> {
  return new Set(app.routes.filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path.replace(/:[^/]+/g, ':id')}`));
}

export function missingOfficialRoutes(
  app: ReturnType<typeof createServer>,
  routes: readonly OfficialRoute[],
  pending: readonly { route: string }[],
): string[] {
  const mounted = mountedOfficialRoutes(app);
  const deferred = new Set(pending.map((entry) => entry.route));
  return routes.map(routeKey).filter((key) => !deferred.has(key) && !mounted.has(key));
}

export async function probeOfficialRoute(app: ReturnType<typeof createServer>, route: OfficialRoute): Promise<Response> {
  const refusedResourceBeta = Object.entries(CMA_REFUSED_RESOURCE_BETAS)
    .find(([prefix]) => route.path === prefix || route.path.startsWith(`${prefix}/`))?.[1];
  return app.request(route.path.replaceAll(':id', 'x_probe'), {
    method: route.method,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': CMA_ANTHROPIC_VERSION,
      'anthropic-beta': refusedResourceBeta ?? (route.path.startsWith('/v1/memory_stores') ? CMA_AGENT_MEMORY_BETA : CMA_MANAGED_AGENTS_BETA),
    },
    ...(['POST', 'PUT', 'PATCH'].includes(route.method) ? { body: '{}' } : {}),
  });
}
