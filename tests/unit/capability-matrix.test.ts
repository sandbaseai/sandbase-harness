/**
 * CMA capability matrix contract.
 *
 * The matrix is the machine-readable claim about what this build implements.
 * These tests pin the properties that make it trustworthy rather than
 * decorative: every contract area has a file, every non-supported status
 * carries a reason, and the status vocabulary is the six-value enum rather
 * than a boolean.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_AREAS,
  CAPABILITY_STATUSES,
  CMA_CAPABILITY_MATRIX,
  capabilityEntry,
  capabilityMatrixJson,
  capabilitySummary,
  capabilitiesWithStatus,
} from '@/core/capabilities/matrix.js';

const CONTRACT_DIR = join(process.cwd(), 'contracts', 'anthropic-cma');

const SEVEN_SECTIONS = [
  '## 1. Official definition',
  '## 2. Current SandBase shape',
  '## 3. Alignment',
  '## 4. Differences',
  '## 5. Reason for the difference',
  '## 6. Corresponding tests',
  '## 7. Status',
];

describe('capability matrix', () => {
  it('uses the documented six-value status vocabulary', () => {
    expect([...CAPABILITY_STATUSES]).toEqual([
      'supported',
      'partial',
      'unavailable',
      'planned',
      'not_applicable',
      'unverified',
    ]);
  });

  it('covers every declared contract area exactly once', () => {
    const areas = new Set(CMA_CAPABILITY_MATRIX.map((entry) => entry.area));
    expect([...areas].sort()).toEqual([...CAPABILITY_AREAS].sort());
  });

  it('gives every entry a unique id', () => {
    const ids = CMA_CAPABILITY_MATRIX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires a reason on every entry, not just the failing ones', () => {
    // A `supported` entry with an empty reason is a claim with no substance, so
    // the requirement is unconditional rather than status-dependent.
    for (const entry of CMA_CAPABILITY_MATRIX) {
      expect(entry.reason.trim().length, `${entry.id} has no reason`).toBeGreaterThan(0);
    }
  });

  it('points every entry at a contract file that exists on disk', () => {
    for (const entry of CMA_CAPABILITY_MATRIX) {
      const path = join(process.cwd(), entry.contract);
      expect(existsSync(path), `${entry.id} cites a missing contract: ${entry.contract}`).toBe(true);
    }
  });

  it('records the areas whose upstream confirmation is still open as unverified', () => {
    // `unverified` is the status for a claim that has not been checked against
    // the published contract. It must stay distinct from `supported` so an
    // unchecked claim is never counted as done.
    expect(capabilitiesWithStatus('unverified').map((entry) => entry.id)).toContain('error-enum-completeness');
  });

  it('does not claim a supported entry is provisional', () => {
    // A `supported` status must not be paired with a reason that admits the
    // behaviour is unconfirmed, or the status overstates the claim.
    for (const entry of capabilitiesWithStatus('supported')) {
      expect(entry.reason.toLowerCase(), `${entry.id} claims support while hedging`).not.toContain('not confirmed against');
    }
  });

  it('records the deliberate non-goals as not_applicable rather than missing', () => {
    const notApplicable = capabilitiesWithStatus('not_applicable').map((entry) => entry.id);
    expect(notApplicable).toEqual(expect.arrayContaining([
      'session-budget-alerts',
      'mcp-tunnel',
    ]));
  });

  it('marks the session budget as implemented with its deviations named', () => {
    // The budget now prices consumption and refuses the next model request at
    // the ceiling, so `planned` would understate it. It is still not
    // `supported`: the price source is operator-supplied rather than official,
    // and a reached ceiling refuses the event instead of pausing the session.
    expect(capabilityEntry('session-budget').status).toBe('partial');
    expect(capabilityEntry('session-budget').contract).toBe('contracts/anthropic-cma/budget.md');
    // A `partial` without a readable deviation is indistinguishable from
    // `supported`, so the specific limitations are pinned rather than trusted.
    const reason = capabilityEntry('session-budget').reason.toLowerCase();
    expect(reason).toContain('cost profile');
    expect(reason).toContain('pause');
  });

  it('covers the areas that are described by prose contracts but easy to omit', () => {
    // The operations domain and the github_repository resource both live outside
    // the canonical agent/session surface, so they are exactly the entries a
    // matrix drifts away from. Pinning them keeps "covered by a contract file"
    // and "present in the matrix" the same fact.
    // The materializer and the file mount are implemented and tested, but no
    // runtime composition injects either, so a session that declares one is
    // accepted and then fails. `supported` here was the drift this work item
    // exists to remove: the helper worked and the capability was unreachable.
    expect(capabilityEntry('github-repository-materialization').status).toBe('partial');
    expect(capabilityEntry('github-repository-materialization').reason.toLowerCase())
      .toContain('no runtime composition');
    expect(capabilityEntry('github-repository-identity-freeze').status).toBe('supported');
    expect(capabilityEntry('file-resources').status).toBe('partial');
    expect(capabilityEntry('file-resources').reason.toLowerCase())
      .toContain('no runtime composition');
    // Webhooks and scheduled deployments *are* covered by the published
    // contract (delivery behaviour, deployment lifecycle), so they are not
    // extensions and cannot be claimed as plain `supported` while the delivery
    // envelope, the disable policy and the deployment control surface differ.
    // See operations.md §4.
    expect(capabilityEntry('webhook-subscriptions').status).toBe('partial');
    expect(capabilityEntry('scheduled-deployment-timers').status).toBe('partial');
    expect(capabilityEntry('outcome-evaluation').status).toBe('supported');
    // The loop was `partial` while a `needs_revision` verdict drove nothing. It
    // is `supported` only because the revision loop, the budget verdicts and the
    // fail-closed refusal of a declaration on a grader-less runtime are all in
    // the tree, so the status is pinned rather than trusted.
    expect(capabilityEntry('outcome-grading').status).toBe('supported');
    expect(capabilityEntry('memory-multi-mount').status).toBe('supported');
  });

  it('names the deviation that keeps each operations entry from being supported', () => {
    // `partial` without a readable deviation is indistinguishable from
    // `supported`. Only the two operations entries are pinned here rather than
    // imposing a wording rule on every partial entry in the matrix. Each pin is
    // an *absence* — the deployment failure split is missing rather than merely
    // spelled differently, and private-address screening is opt-in rather than
    // unconditional.
    // An absence is pinned rather than a topic word because the earlier wording
    // named both topics while claiming the behaviour worked, so a topic word would
    // pass on either text. This pin has now moved four times, and the fourth move is
    // the one worth remembering: the first three narrowed it as each published rule
    // landed, and this one removed a clause that had become *false* — the `2xx` reset
    // it still called absent is the reset the sustained-failure rule implements, so
    // the same file said in §4 that the reset existed and here that it did not. A pin
    // on a stale absence is worse than no pin: it reports a gap the code has closed,
    // and it is only visible by comparing the claim against the behaviour rather than
    // against the code's own prose. The fifth move is the same lesson again: the
    // retry-jitter change and the deployment pause, alias, run-collection and
    // lifecycle-event changes each landed while these pins still asserted their
    // absence, so the pins below name only what is still missing.
    expect(capabilityEntry('webhook-subscriptions').reason.toLowerCase())
      .toContain('only when the deployment sets managed_agents_webhook_screen_private_addresses');
    expect(capabilityEntry('scheduled-deployment-timers').reason.toLowerCase())
      .toContain('there is no failure split');
  });

  it('does not describe shipped operations behaviour as absent', () => {
    // Each phrase below was once true and was left in place after the code
    // that closed it landed. Pinning their absence keeps a stale gap from
    // reappearing in the reason the capability endpoint serves.
    const webhooks = capabilityEntry('webhook-subscriptions').reason.toLowerCase();
    expect(webhooks).not.toContain('fixed 60s/120s');
    expect(webhooks).toContain('jittered 5-120s exponential backoff');
    const deployments = capabilityEntry('scheduled-deployment-timers').reason.toLowerCase();
    for (const stale of ['no /v1/deployments alias', 'no pause/unpause', 'no deployment.* lifecycle events', 'must be driven by a caller']) {
      expect(deployments).not.toContain(stale);
    }
  });

  it('does not claim a canonical capability the runtime only wires through an extension', () => {
    // Operations is a local extension; the matrix record must say so rather than
    // reading as upstream alignment.
    for (const id of ['webhook-subscriptions', 'scheduled-deployment-timers', 'outcome-evaluation']) {
      expect(capabilityEntry(id).contract).toBe('contracts/anthropic-cma/operations.md');
    }
  });

  it('reports the unimplemented behaviours explicitly', () => {
    expect(capabilityEntry('web-search-execution').status).toBe('unavailable');
    // WebFetch is the implemented half; the search entry must not read as if
    // every web tool were still missing an executor.
    expect(capabilityEntry('web-fetch-execution').status).toBe('partial');
    // Not `planned`: no refresh loop is scheduled, and the plan's acceptance for
    // this item is "implement it or mark it unavailable". Calling it planned
    // would imply a refresh loop is coming.
    expect(capabilityEntry('oauth-refresh').status).toBe('unavailable');
    expect(capabilityEntry('oauth-refresh').reason.toLowerCase()).toContain('warning');
    // Threads are a real gap, not a spelling difference: no thread resource, no
    // coordinator or advisor role, and no thread route exist. The earlier
    // `partial` reading described files that were never in the tree.
    expect(capabilityEntry('threads-and-coordinator').status).toBe('unavailable');
    expect(capabilityEntry('threads-and-coordinator').contract).toBe('contracts/anthropic-cma/threads.md');
  });

  it('names the surface that keeps the thread entry unavailable', () => {
    // `unavailable` has to be readable as a real absence rather than as a
    // placeholder, so the missing pieces are pinned rather than trusted.
    const reason = capabilityEntry('threads-and-coordinator').reason.toLowerCase();
    expect(reason).toContain('not implemented');
    expect(reason).toContain('no coordinator or advisor role');
    expect(reason).toContain('enable_general_subagent');
  });

  it('refuses the canonical multiagent roster while keeping local delegation', () => {
    // The two facts have to stay apart: the roster is a canonical surface this
    // runtime refuses by name, and the single-level delegation extension is
    // what actually exists. One entry claiming both would be the drift back.
    expect(capabilityEntry('multiagent-roster').status).toBe('unavailable');
    expect(capabilityEntry('multiagent-roster').reason.toLowerCase()).toContain('refused by name');
    expect(capabilityEntry('local-delegation-subagent').status).toBe('supported');
    expect(capabilityEntry('local-delegation-subagent').reason.toLowerCase())
      .toContain('enable_general_subagent');
    expect(capabilityEntry('local-delegation-subagent').reason.toLowerCase())
      .not.toContain('multiagent roster is supported');
  });

  it('throws on an unknown capability id instead of returning undefined', () => {
    expect(() => capabilityEntry('no-such-capability')).toThrow(/Unknown capability/);
  });

  it('summarizes every status, including the zero counts', () => {
    const summary = capabilitySummary();
    for (const status of CAPABILITY_STATUSES) {
      expect(summary[status], `${status} missing from summary`).toBeTypeOf('number');
    }
    const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(CMA_CAPABILITY_MATRIX.length);
  });

  it('projects a stable machine-readable envelope', () => {
    const json = capabilityMatrixJson();
    expect(json.type).toBe('capability_matrix');
    expect(json.statuses).toEqual(CAPABILITY_STATUSES);
    expect(json.capabilities).toHaveLength(CMA_CAPABILITY_MATRIX.length);
    expect(json.summary).toEqual(capabilitySummary());
  });

  it('returns copies so a consumer cannot mutate the matrix', () => {
    const first = capabilityEntry('dreams');
    first.status = 'supported';
    expect(capabilityEntry('dreams').status).toBe('unavailable');
  });
});

describe('contract documents', () => {
  const contractFiles = ['README.md', ...CAPABILITY_AREAS.map((area) => `${area}.md`)];

  it.each(contractFiles)('%s exists', (file) => {
    expect(existsSync(join(CONTRACT_DIR, file)), `${file} is missing`).toBe(true);
  });

  it.each(CAPABILITY_AREAS.map((area) => `${area}.md`))('%s uses the seven-section format', (file) => {
    const content = readFileSync(join(CONTRACT_DIR, file), 'utf8');
    for (const section of SEVEN_SECTIONS) {
      expect(content, `${file} is missing "${section}"`).toContain(section);
    }
  });

  it('keeps the area list in step with the documented file list', () => {
    // The README table and the CAPABILITY_AREAS constant are two halves of one
    // fact; a file present in one and absent from the other is how a contract
    // silently stops being maintained.
    const readme = readFileSync(join(CONTRACT_DIR, 'README.md'), 'utf8');
    for (const area of CAPABILITY_AREAS) {
      expect(readme, `README does not list ${area}.md`).toContain(`${area}.md`);
    }
  });
});
