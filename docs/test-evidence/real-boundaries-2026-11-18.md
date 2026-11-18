# Real execution boundary verification — 2026-11-18

Verification-only pass over the runnable real boundaries, on the
`feat/alignment-batch` worktree at `4f01b6b` (tip of the alignment batch,
five commits on `29a577c`). Honest accounting per CONTRIBUTING: a boundary
is recorded verified only where its actual gate ran; provider, credential,
Docker, and Kubernetes gaps are named as blockers, not smoothed over.

Host: macOS (Darwin 27.2.0), Node via repo toolchain, `ANTHROPIC_API_KEY`
unset, no `docker` daemon, no reachable Kubernetes cluster.

## Verified this run

| Boundary | Suite | Result |
| --- | --- | --- |
| Docker provider API surface — path containment (`/workspace` root), workspace path projection, provider registration, `isDockerAvailable` gating | `tests/integration/docker-sandbox.test.ts` | 9 pass, 2 skipped (container-lifecycle cases gated on a daemon; see below) |
| Limited-policy enforcement projection (`enforced`/`best_effort`/`unsupported`/`not_applicable`) | `tests/integration/environment-network-enforcement.test.ts` | 5 pass |
| Official-SDK quickstart route/beta surface under 1.8.0 | `tests/conformance/official-sdk-quickstart.test.ts` | pass except the Docker-backed turn (skipped, daemon absent) |
| Local egress proxy — CONNECT and absolute-URI allow/deny, allowlist matching, redirect-hop checks | `tests/unit/egress-proxy.test.ts` | 16 pass |
| Credential execution + canonical `__cred_<id>__` wire substitution + environment worker keys | `tests/integration/credential-execution.test.ts`, `canonical-credential-wire.test.ts`, `environment-worker-keys.test.ts` | 66 pass combined with the three below |
| Worker recovery (crash → claim expiry → re-poll) | `tests/integration/crash-recovery.test.ts` | pass |
| Scheduled-run resume (pause/resume, runs collection, work data plane) | `tests/integration/deployment-pause-resume.test.ts`, `deployment-runs-collection.test.ts`, `environment-work-data-plane.test.ts` | pass |
| Scheduled deployment timezone + session rescheduling | `tests/integration/scheduled-deployment-timezone.test.ts`, `session-rescheduling.test.ts` | 11 pass |
| Full conformance oracle under SDK 1.8.0 | `tests/conformance/` | 103 pass / 36 files, 1 skipped |

## Skipped — provider or credential unavailable

| Boundary | Why it did not run | What it would prove |
| --- | --- | --- |
| Docker egress enforcement end-to-end (`--internal` network + relay sidecar actually bounding a container's egress) | `docker info` fails — no daemon on this host | That a sandboxed process cannot reach a non-allowlisted host even when it ignores proxy env vars |
| Kubernetes NetworkPolicy boundary | `isKubernetesAvailable()` false — no kubeconfig/cluster | That a limited policy installs a NetworkPolicy pinning egress to the proxy |
| Live model turns through the published SDK | `ANTHROPIC_API_KEY` unset | A full billed turn, tool call, and usage record against the real model |
| Real MCP / HTTPS credential flows over the wire | No live MCP endpoint or credential-backed HTTPS target configured | `__cred_<id>__` substitution inside an actual CONNECT tunnel |
| `live-docs-examples` re-crawl | Same missing model credential | Published curl examples against a real endpoint |

## Known pre-existing noise (not this batch)

- `tests/unit/local-sandbox.test.ts` + two `pi-launcher.test.ts` cases fail on
  macOS `/private/var` vs `/var` tmp-path assertions — documented in PR #955
  as unrelated to dependency upgrades; still failing on this host, still
  asserted against `main`-era expectations.

## Next safe action

Re-run the two container-backed rows on a host with a Docker daemon (CI's
Docker job or a workstation), and the Kubernetes row on any reachable
cluster. Until then the honest capability claims stand: Docker/Kubernetes
enforcement is a code path with unit coverage and a skipped integration
gate, not a verified boundary on this machine.
