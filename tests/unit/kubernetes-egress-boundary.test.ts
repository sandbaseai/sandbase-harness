/**
 * The kubernetes egress boundary a `limited` policy installs.
 *
 * The bypass property these tests pin is the one the brief names: a process
 * inside the sandbox Pod that ignores its injected proxy variables must have
 * no permitted egress peer — so the NetworkPolicy's `to` set is DNS plus the
 * session's own relay, nothing else. The manifest builders are pure, which is
 * where the assertion belongs: the policy shape is the enforcement.
 */

import { describe, expect, it } from 'vitest';
import {
  buildNetworkPolicyManifest,
  buildPodManifest,
  buildProxyPodManifest,
  buildProxyServiceManifest,
} from '@/sandbox/kubernetes-provider.js';

describe('kubernetes egress boundary manifests', () => {
  it('pins the sandbox Pod egress to DNS plus its own relay only', () => {
    const policy = buildNetworkPolicyManifest({
      name: 'ma-net-test',
      namespace: 'agents',
      sessionId: 'sess_1',
    });
    const spec = policy.spec as {
      podSelector: { matchLabels: Record<string, string> };
      policyTypes: string[];
      egress: Array<{ to?: unknown[]; ports?: unknown[] }>;
    };

    // The policy applies to exactly one Pod — the session's — by its own
    // label, so a second session in the same namespace is unaffected.
    expect(spec.podSelector.matchLabels).toEqual({ 'managed-agents/session-id': 'sess_1' });
    expect(spec.policyTypes).toEqual(['Egress']);

    // Two egress rules and no more: DNS (kube-dns) and the relay.
    expect(spec.egress).toHaveLength(2);
    const [dns, relay] = spec.egress;

    const dnsPeers = (dns.to ?? []) as Array<{ podSelector?: { matchLabels?: Record<string, string> } }>;
    expect(dnsPeers[0]?.podSelector?.matchLabels).toEqual({ 'k8s-app': 'kube-dns' });
    expect((dns.ports ?? []).map((p) => (p as { port: number }).port).sort()).toEqual([53, 53]);

    const relayPeers = (relay.to ?? []) as Array<{ podSelector?: { matchLabels?: Record<string, string> } }>;
    expect(relayPeers[0]?.podSelector?.matchLabels).toEqual({ 'managed-agents/proxy-for': 'sess_1' });
    expect((relay.ports ?? []).map((p) => (p as { port: number }).port)).toEqual([8080]);

    // The bypass claim: nothing outside these two `to` peers is admitted.
    // Any broader peer — an ipBlock, a second namespace, a wildcard — would
    // widen the boundary past the allowlist the relay enforces.
    const allPeers = spec.egress.flatMap((rule) => rule.to ?? []);
    expect(allPeers).toHaveLength(2);
  });

  it('names the relay as the only non-DNS peer by the session label', () => {
    const relay = buildProxyPodManifest({
      podName: 'ma-proxy-x',
      namespace: 'agents',
      sessionId: 'sess_1',
      proxyHost: 'host.docker.internal',
      proxyPort: 12345,
    });
    const meta = relay.metadata as { labels: Record<string, string> };
    // The NetworkPolicy's podSelector selects exactly this label.
    expect(meta.labels['managed-agents/proxy-for']).toBe('sess_1');
    const spec = relay.spec as { containers: Array<{ args: string[] }> };
    expect(spec.containers[0]?.args[1]).toBe('TCP:host.docker.internal:12345');
  });

  it('binds the Service selector to the relay label, not the session Pod', () => {
    const service = buildProxyServiceManifest({
      name: 'ma-proxy-x',
      namespace: 'agents',
      sessionId: 'sess_1',
      podName: 'ma-proxy-x',
    });
    const spec = service.spec as { selector: Record<string, string> };
    expect(spec.selector).toEqual({ 'managed-agents/proxy-for': 'sess_1' });
  });

  it('injects the proxy env into the sandbox Pod container', () => {
    const manifest = buildPodManifest({
      podName: 'ma-x',
      namespace: 'agents',
      sessionId: 'sess_1',
      config: { name: 'k', type: 'kubernetes' } as never,
      settings: {},
      egressEnvironment: { HTTPS_PROXY: 'http://sandbase:tok@ma-proxy-x.agents.svc.cluster.local:8080' },
    });
    const spec = manifest.spec as { containers: Array<{ env?: Array<{ name: string; value: string }> }> };
    expect(spec.containers[0]?.env).toEqual([
      { name: 'HTTPS_PROXY', value: 'http://sandbase:tok@ma-proxy-x.agents.svc.cluster.local:8080' },
    ]);
  });

  it('omits env when no boundary was provisioned', () => {
    const manifest = buildPodManifest({
      podName: 'ma-x',
      namespace: 'agents',
      sessionId: 'sess_1',
      config: { name: 'k', type: 'kubernetes' } as never,
      settings: {},
    });
    const spec = manifest.spec as { containers: Array<{ env?: unknown }> };
    expect(spec.containers[0]?.env).toBeUndefined();
  });
});
