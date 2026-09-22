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
      'dreams',
      'mcp-tunnel',
    ]));
  });

  it('marks the designed session budget as planned rather than implemented', () => {
    // Session budget is neither a non-goal nor a shipped behaviour: the design
    // is published as budget.md, while nothing in the runtime prices model
    // consumption or enforces a ceiling. `partial` would claim enforcement that
    // does not exist, and `not_applicable` would deny work that is scheduled.
    expect(capabilityEntry('session-budget').status).toBe('planned');
    expect(capabilityEntry('session-budget').contract).toBe('contracts/anthropic-cma/budget.md');
    // The entry has to say what is missing, not only carry a status.
    expect(capabilityEntry('session-budget').reason.toLowerCase()).toContain('not implemented');
  });

  it('covers the areas that are described by prose contracts but easy to omit', () => {
    // The operations domain and the github_repository resource both live outside
    // the canonical agent/session surface, so they are exactly the entries a
    // matrix drifts away from. Pinning them keeps "covered by a contract file"
    // and "present in the matrix" the same fact.
    expect(capabilityEntry('github-repository-materialization').status).toBe('supported');
    expect(capabilityEntry('github-repository-identity-freeze').status).toBe('supported');
    // Webhooks and scheduled deployments *are* covered by the published
    // contract (delivery behaviour, deployment lifecycle), so they are not
    // extensions and cannot be claimed as plain `supported` while their endpoint
    // paths and event vocabulary still differ. See operations.md §4.
    expect(capabilityEntry('webhook-subscriptions').status).toBe('partial');
    expect(capabilityEntry('scheduled-deployment-timers').status).toBe('partial');
    expect(capabilityEntry('outcome-evaluation').status).toBe('supported');
    expect(capabilityEntry('memory-multi-mount').status).toBe('supported');
  });

  it('names the deviation that keeps each operations entry from being supported', () => {
    // `partial` without a readable deviation is indistinguishable from
    // `supported`. Only the two operations entries are pinned here rather than
    // imposing a wording rule on every partial entry in the matrix.
    expect(capabilityEntry('webhook-subscriptions').reason.toLowerCase())
      .toContain('opt-in');
    expect(capabilityEntry('scheduled-deployment-timers').reason.toLowerCase())
      .toContain('/v1/deployments');
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
    // Threads are implemented with recorded deviations, so the entry must name
    // them rather than fall back to a blanket `planned`.
    expect(capabilityEntry('threads-and-coordinator').status).toBe('partial');
    expect(capabilityEntry('threads-and-coordinator').contract).toBe('contracts/anthropic-cma/threads.md');
  });

  it('names the deviation that keeps the thread entry from being supported', () => {
    // `partial` without a readable deviation is indistinguishable from
    // `supported`, so the specific limitation is pinned rather than trusted.
    expect(capabilityEntry('threads-and-coordinator').reason.toLowerCase())
      .toContain('delegations list');
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
    expect(capabilityEntry('dreams').status).toBe('not_applicable');
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
