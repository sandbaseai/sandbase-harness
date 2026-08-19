# Documentation

This directory contains public, project-owned documentation for
`managed-agents`. It is written for users, contributors, and operators of the
open-source runtime.

## Start Here

| Document | Audience | Contents |
| --- | --- | --- |
| [Installation](installation.md) | Users and operators | Install options, model configuration, startup flags, and health checks. |
| [MiniMax](minimax.md) | MiniMax users | Regional endpoints, model IDs, settings, and verification. |
| [Usage Guide](usage.md) | Users and integrators | Workspace layout, Console workflows, sessions, sandbox backends, resources, credentials, memory, and SDK usage. |
| [API Reference](api.md) | API and SDK integrators | HTTP endpoints, request shapes, response shapes, errors, and examples. |
| [Versioned API Matrix](api-matrix.md) | SDK authors and integrators | `/v1` endpoint status, SDK coverage, CLI coverage, and compatibility gaps. |
| [Skills](skills.md) | Agent builders | Skill package format, upload flow, validation rules, and agent references. |
| [Requirements](spec/requirements.md) | Users and maintainers | Product scope, runtime guarantees, and release-facing requirements. |
| [Technical Design](spec/design.md) | Contributors | Core concepts, data model, extension contracts, and API groups. |
| [Architecture](spec/architecture.md) | Contributors and operators | System diagrams, data boundaries, session flow, and deployment modes. |
| [Implementation Status](spec/tasks.md) | Contributors | Completed work, active work, planned items, and release checks. |
| [Changelog](../CHANGELOG.md) | Users and maintainers | Release notes and first-release boundaries. |

## Screenshots

Screenshots used by the README live in [`assets/`](assets/):

- [`dashboard-overview.png`](assets/dashboard-overview.png)
- [`dashboard-settings-models.png`](assets/dashboard-settings-models.png)
- [`dashboard-api-reference.png`](assets/dashboard-api-reference.png)

## Advanced / Optional

These documents are not part of the v1 quick-start path. Read them after the
local SQLite + local filesystem runtime is working.

| Document | Audience | Contents |
| --- | --- | --- |
| [Deployment Examples](deployment.md) | Operators | systemd, Docker Compose, running the runtime on Kubernetes, the RBAC for Kubernetes session sandboxes, self-hosted workers, and production checks. |

## Release Gate

For a source checkout, the maintainer release gate is:

```bash
npm run release:check
```

It runs typecheck, tests, production builds, package dry-run, and CLI smoke
checks for `managed-agents init` plus `examples/basic` startup.

## Documentation Rules

- Public docs describe this project only.
- Public docs avoid internal planning notes and external comparison material.
- Requirements describe observable behavior.
- Design docs describe stable architecture and extension points.
- Implementation status tracks current state without replacing issue tracking.
