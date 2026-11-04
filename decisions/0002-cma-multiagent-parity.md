# 0002 — Restore the official multiagent surface to the CMA target

Date: 2026-11-02
Status: decided
Supersedes: [0001 — Multiagent surface is permanently out of scope](0001-multiagent-out-of-scope.md)
Scope: the published `multiagent_20261001` block, session threads, subagents,
workflow runs, advisor consultations, and their events and lifecycle rules.

## Decision

The official multiagent surface is part of the CMA compatibility target.
It is currently **unavailable**, not implemented and not permanently excluded.
Decision 0001 remains unchanged as the record of the earlier scope choice.

The agent write paths and the five thread routes continue to refuse requests
before persistence or execution. A scope decision does not supply an executor.
Local `delegations` and `enable_general_subagent` remain separate extensions
and do not satisfy the official contract.

## Why

Full CMA compatibility requires the published orchestration behavior as well
as single-session execution. Removing a capability from the denominator makes
an inventory easier to complete without helping a client that needs it.
The architectural work identified in decision 0001 remains necessary: durable
thread identity, isolated context, shared session resources and spending,
status aggregation, interrupt routing, and a background workflow lifecycle.

## Consequences

- `multiagent-roster` and `threads-and-coordinator` report `unavailable` in
  the capability matrix, contract documents, and generated README tables.
- [BACKLOG.md](../BACKLOG.md#cma-compatibility) records the implementation
  tracks and their acceptance criteria. Each change still follows the
  one-behavior-per-PR rule; no date or delivery commitment is implied.
- A partial rollout must explicitly refuse unsupported members and operations.
  A thread without context isolation or a workflow event without a persisted
  run is not sufficient to enable that surface.
- Existing tunnel, hosted user-profile, and billing-notification exclusions
  remain visible decisions to revisit against the full compatibility goal.
  This decision does not implement or reclassify those surfaces, and they
  cannot be counted as completed CMA capabilities.
- SandBase remains an independent, self-hosted project. The target does not
  imply current full compatibility or affiliation with Anthropic.
