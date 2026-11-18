import type { Database } from '../db/database.js';
import { LocalSandboxProvider } from '../../sandbox/local-provider.js';
import { DockerSandboxProvider, isDockerAvailable } from '../../sandbox/docker-provider.js';
import { KubernetesSandboxProvider, isKubernetesAvailable, type KubernetesProviderLogger } from '../../sandbox/kubernetes-provider.js';
import { SandboxProviderRegistry } from '../../sandbox/registry.js';
import { SelfHostedSandboxProvider, WorkQueue } from '../../sandbox/self-hosted-provider.js';
import { SessionWorkQueue } from '../../sandbox/session-work-queue.js';

export interface RuntimeSandboxBootstrapOptions {
  db: Database;
  dataDir: string;
  dockerAvailable?: () => boolean;
  kubernetesAvailable?: () => boolean;
  /** Sink for cluster-side failures (e.g. a Pod that could not be deleted). */
  logger?: KubernetesProviderLogger;
}

export interface RuntimeSandboxBootstrapResult {
  sandboxProvider: LocalSandboxProvider;
  sandboxRegistry: SandboxProviderRegistry;
  workQueue: WorkQueue;
  sessionWorkQueue: SessionWorkQueue;
  dockerAvailable: boolean;
  kubernetesAvailable: boolean;
}

/**
 * Register the sandbox backends this process can actually serve.
 *
 * A backend whose transport is missing (no Docker daemon, no reachable
 * cluster) is deliberately left unregistered rather than registered and left
 * to fail later: the registry is what Settings V2 availability and Environment
 * resolution both read, so an unavailable backend must be absent there for
 * `sandbox.provider` validation and provision-time errors to be accurate.
 */
export function bootstrapRuntimeSandboxes(options: RuntimeSandboxBootstrapOptions): RuntimeSandboxBootstrapResult {
  const sandboxProvider = new LocalSandboxProvider(options.dataDir);
  const sandboxRegistry = new SandboxProviderRegistry();
  sandboxRegistry.register(sandboxProvider);

  const dockerAvailable = (options.dockerAvailable ?? isDockerAvailable)();
  if (dockerAvailable) {
    sandboxRegistry.register(new DockerSandboxProvider());
  }

  // Probed with the ambient kubeconfig / current context. A per-Environment
  // kubeconfig or context still applies at provision time; this check only
  // decides whether the backend is offered at all.
  const kubernetesAvailable = (options.kubernetesAvailable ?? (() => isKubernetesAvailable()))();
  if (kubernetesAvailable) {
    sandboxRegistry.register(new KubernetesSandboxProvider(options.logger));
  }

  // self_hosted: a worker claims a whole session (the published claim unit,
  // `SessionWorkQueue`); the per-call tool items it parks are the calls that
  // claim contains, drained under it on the local worker channel (`WorkQueue`).
  const workQueue = new WorkQueue(options.db);
  const sessionWorkQueue = new SessionWorkQueue(options.db);
  sandboxRegistry.register(new SelfHostedSandboxProvider(workQueue, sessionWorkQueue));

  return {
    sandboxProvider,
    sandboxRegistry,
    workQueue,
    sessionWorkQueue,
    dockerAvailable,
    kubernetesAvailable,
  };
}
