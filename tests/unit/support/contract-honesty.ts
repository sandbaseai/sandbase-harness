/**
 * Contract honesty checks.
 *
 * The capability matrix, the prose under `contracts/anthropic-cma/`, the tests
 * that actually exist, and the routes the server really mounts are four
 * descriptions of one build. They drift apart silently because nothing compares
 * them: two of the documented drifts this module exists to catch were a contract
 * that named a test file nobody had written and a matrix entry that claimed an
 * endpoint no module mounts.
 *
 * Every check here is a pure function over its input, so the same rules can run
 * against the repository (in `tests/unit/contract-honesty.test.ts`) and against
 * deliberately broken fixtures. A guard whose failure mode is untested is a
 * guard that can pass by finding nothing.
 *
 * The three document conventions these checks rely on:
 *
 * 1. A contract file restates the status of every matrix entry that cites it in
 *    a `<!-- capability-status … -->` block. Prose explains; the block is what
 *    is compared.
 * 2. Paths a contract file cites are written in backticks, so a cited test or
 *    source file is checkable rather than decorative. §2 (`## 2. Current
 *    SandBase shape`) is the evidence for an implementation claim and §6
 *    (`## 6. Corresponding tests`) for a tested one.
 * 3. Routes live in a markdown table whose first two cells are the method and a
 *    backticked path.
 */

import type { CapabilityEntry, CapabilityStatus } from '@/core/capabilities/matrix.js';
import { CAPABILITY_STATUSES } from '@/core/capabilities/matrix.js';
import { routeKey } from './route-table.js';

/**
 * Statuses that assert an implementation exists in the tree.
 *
 * `unavailable`, `planned`, and `not_applicable` say the opposite, so requiring
 * a source file for them would be requiring a lie; they are exempt by design,
 * not by omission.
 */
export const IMPLEMENTATION_STATUSES: readonly CapabilityStatus[] = [
  'supported',
  'partial',
  'unverified',
];

/** Statuses whose claim includes a test that exercises the behaviour. */
export const TESTED_STATUSES: readonly CapabilityStatus[] = ['supported', 'partial'];

/**
 * A capability whose reachability is decided by the composition root.
 *
 * An implementation that exists but is never injected is not `supported`: a
 * caller cannot use it, and a test that constructs it by hand proves the helper
 * works rather than that the capability is reachable. Wiring the symbol is
 * therefore the first half of the claim, and `blocker` is the second.
 */
export interface WiringRequirement {
  /** File that must reference the symbol for the capability to be reachable. */
  file: string;
  symbol: string;
  /**
   * The reason a wired capability is still `partial`, and the canary pinning it.
   *
   * These two capabilities are the case the wiring rule alone gets wrong. Both
   * symbols are injected by the composition root now, so "wired" no longer
   * implies "reachable": a session's resources are materialized through the
   * selected sandbox backend. The local backend reaches the canonical in-sandbox
   * roots the lifecycle writes to, so a session there does materialize what it
   * declared and the agent is told where it landed; docker still refuses them
   * (kubernetes accepts the repository root and refuses the upload root), and the
   * published contract asks for a session the selected backend cannot serve to be
   * refused when it is created rather than fail at provisioning. The runtime
   * reaches the code and part of the claim is still unhonoured, which is exactly
   * what `partial` means.
   *
   * Recording the blocker as a marker in the test that demonstrates it keeps the
   * status honest in both directions. The canary fails first when a backend is
   * fixed, and this guard fails if the status moves to `supported` while the
   * canary still pins the gap — or if the canary is gone and the status has not
   * moved.
   */
  blocker?: { file: string; symbol: string; detail: string };
}

export const PRODUCTION_WIRING: Readonly<Record<string, WiringRequirement>> = {
  'github-repository-materialization': {
    file: 'src/core/runtime/session-runtime.ts',
    symbol: 'githubMaterializer',
    blocker: {
      file: 'tests/integration/session-resource-wiring.test.ts',
      symbol: 'still refuses the canonical repository mount root on docker, and kubernetes still accepts it',
      detail: 'the docker sandbox backend refuses the canonical /workspace mount root',
    },
  },
  'file-resources': {
    file: 'src/core/runtime/session-runtime.ts',
    symbol: 'fileArtifactReader',
    blocker: {
      file: 'tests/integration/session-resource-wiring.test.ts',
      symbol: 'still refuses the canonical file mount root on the container backends',
      detail: 'the docker and kubernetes sandbox backends refuse the canonical /mnt/session/uploads mount root',
    },
  },
  'local-delegation-subagent': {
    file: 'src/core/session/delegation-service.ts',
    symbol: 'enable_general_subagent',
  },
};

export interface ContractDocument {
  /** File name inside `contracts/anthropic-cma/`, for example `agents.md`. */
  name: string;
  text: string;
}

export interface ContractHonestyInput {
  entries: readonly CapabilityEntry[];
  documents: readonly ContractDocument[];
  /** Text of a repository-relative file, or `undefined` when it does not exist. */
  read: (path: string) => string | undefined;
  /** `routeKey()` values for the routes the server actually mounts. */
  mountedRouteKeys: ReadonlySet<string>;
  /** Overridable so a fixture can prove the wiring rule fires. */
  wiring?: Readonly<Record<string, WiringRequirement>>;
}

export interface StatusBlock {
  present: boolean;
  statuses: Map<string, CapabilityStatus>;
  problems: string[];
}

const STATUS_BLOCK = /<!--\s*capability-status\s*\n([\s\S]*?)-->/;
const STATUS_LINE = /^\s*([A-Za-z0-9._-]+)\s*:\s*([a-z_]+)\s*$/;
const ROUTE_ROW = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`|]+)`\s*\|/;
const PATH_REFERENCE = /`((?:src|tests)\/[A-Za-z0-9_\-./]+)`/g;
/** The convention has to be documented somewhere; an example is not a declaration. */
const FENCED_BLOCK = /```[\s\S]*?```/g;
/** Section that describes the local implementation. */
const SECTION_SHAPE = '## 2. Current SandBase shape';
/** Section that names the tests a claim rests on. */
const TEST_SECTION = '## 6. Corresponding tests';

/**
 * Read the machine-readable status block.
 *
 * A missing block is reported by the caller rather than here, because a document
 * no matrix entry cites has nothing to declare.
 */
export function parseStatusBlock(text: string): StatusBlock {
  const problems: string[] = [];
  const statuses = new Map<string, CapabilityStatus>();
  const match = STATUS_BLOCK.exec(text.replace(FENCED_BLOCK, ''));

  if (!match) return { present: false, statuses, problems };

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parsed = STATUS_LINE.exec(line);
    if (!parsed) {
      problems.push(`capability-status block has an unparsable line: "${line}"`);
      continue;
    }
    const [, id, status] = parsed;
    if (!CAPABILITY_STATUSES.includes(status as CapabilityStatus)) {
      problems.push(`capability-status block declares "${id}" with unknown status "${status}"`);
      continue;
    }
    if (statuses.has(id)) {
      problems.push(`capability-status block declares "${id}" twice`);
      continue;
    }
    statuses.set(id, status as CapabilityStatus);
  }

  return { present: true, statuses, problems };
}

/** Repository-relative `src/` and `tests/` paths a document cites in backticks. */
export function parseReferencedPaths(text: string, prefix: 'src/' | 'tests/'): string[] {
  const found = new Set<string>();
  for (const match of text.replace(FENCED_BLOCK, '').matchAll(PATH_REFERENCE)) {
    if (match[1].startsWith(prefix)) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * The body of one numbered section, up to the next top-level heading.
 *
 * Evidence is read per section rather than per document so a file mentioned in
 * a difference table cannot stand in for the implementation a status claims.
 */
export function parseSection(text: string, heading: string): string | undefined {
  const body = text.replace(FENCED_BLOCK, '');
  const start = body.indexOf(heading);
  if (start === -1) return undefined;
  const rest = body.slice(start + heading.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Routes a document declares, as `routeKey()` values.
 *
 * Only table rows count. The same document may mention a published route in
 * prose while explaining that this runtime does not implement it, and treating
 * that mention as a promise would make an honest contract fail the guard. Rows
 * inside a fenced block are examples of the convention, not declarations.
 */
export function parseDocumentedRoutes(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.replace(FENCED_BLOCK, '').split('\n')) {
    const match = ROUTE_ROW.exec(line);
    if (match) found.add(routeKey(match[1], match[2]));
  }
  return [...found].sort();
}

/** Matrix entries whose `contract` field points at one document. */
export function entriesForDocument(
  entries: readonly CapabilityEntry[],
  name: string,
): CapabilityEntry[] {
  return entries.filter((entry) => entry.contract === `contracts/anthropic-cma/${name}`);
}

/**
 * Every rule, over injectable input.
 *
 * Returns a sorted list of human-readable problems; an empty list means the
 * matrix, the documents, and the mounted routes describe the same build.
 */
export function checkContractHonesty(input: ContractHonestyInput): string[] {
  const problems: string[] = [];
  const wiring = input.wiring ?? PRODUCTION_WIRING;
  const documents = new Map(input.documents.map((document) => [document.name, document]));

  problems.push(...checkEntryIdentifiers(input.entries, input.read));

  const documentedRoutes = new Set<string>();
  for (const document of input.documents) {
    for (const key of parseDocumentedRoutes(document.text)) documentedRoutes.add(key);
  }
  problems.push(...checkRoutes(documentedRoutes, input.mountedRouteKeys));

  for (const name of new Set(
    input.entries.map((entry) => entry.contract.replace('contracts/anthropic-cma/', '')),
  )) {
    const document = documents.get(name);
    if (!document) {
      // Reported once per entry by `checkEntryIdentifiers`; a missing file has
      // no status block and no citations to inspect.
      continue;
    }
    problems.push(...checkDocument(document, entriesForDocument(input.entries, name), input));
  }

  problems.push(...checkProductionWiring(input.entries, wiring, input.read));

  return [...new Set(problems)].sort();
}

/** Every `contract` path resolves to a document, and no `id` is reused. */
function checkEntryIdentifiers(
  entries: readonly CapabilityEntry[],
  read: (path: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`matrix entry id is not unique: ${entry.id}`);
    seen.add(entry.id);

    if (!entry.contract.startsWith('contracts/anthropic-cma/')) {
      problems.push(`${entry.id} cites a contract outside contracts/anthropic-cma/: ${entry.contract}`);
      continue;
    }
    if (read(entry.contract) === undefined) {
      problems.push(`${entry.id} cites a contract file that does not exist: ${entry.contract}`);
    }
  }

  return problems;
}

/** One document against the entries that cite it, and against the file tree. */
function checkDocument(
  document: ContractDocument,
  entries: readonly CapabilityEntry[],
  input: ContractHonestyInput,
): string[] {
  const problems: string[] = [];
  const block = parseStatusBlock(document.text);

  for (const problem of block.problems) problems.push(`${document.name}: ${problem}`);

  if (!block.present) {
    problems.push(`${document.name}: no <!-- capability-status --> block`);
  } else {
    const expected = new Map(entries.map((entry) => [entry.id, entry.status]));
    for (const [id, status] of expected) {
      const declared = block.statuses.get(id);
      if (declared === undefined) {
        problems.push(`${document.name}: status block omits ${id} (${status})`);
      } else if (declared !== status) {
        problems.push(
          `${document.name}: status block says ${id} is "${declared}" but the matrix says "${status}"`,
        );
      }
    }
    for (const [id, status] of block.statuses) {
      if (!expected.has(id)) {
        problems.push(`${document.name}: status block declares ${id} (${status}) which does not cite this file`);
      }
    }
  }

  const sourcePaths = parseReferencedPaths(document.text, 'src/');
  const testPaths = parseReferencedPaths(document.text, 'tests/');

  for (const path of sourcePaths) {
    if (input.read(path) === undefined) problems.push(`${document.name}: cites a source file that does not exist: ${path}`);
  }
  for (const path of testPaths) {
    if (input.read(path) === undefined) problems.push(`${document.name}: cites a test file that does not exist: ${path}`);
  }

  // The evidence rules read the sections that make the claim: §2 describes the
  // implementation, §6 names the tests. A path mentioned anywhere else is a
  // citation (checked above) but not evidence, so a document cannot satisfy
  // "this is implemented and tested" by mentioning a file in a footnote.
  const claimsImplementation = entries.some((entry) => IMPLEMENTATION_STATUSES.includes(entry.status));
  const claimsTests = entries.some((entry) => TESTED_STATUSES.includes(entry.status));

  if (claimsImplementation) {
    const section = parseSection(document.text, SECTION_SHAPE);
    const cited = section === undefined ? [] : parseReferencedPaths(section, 'src/');
    const existing = cited.filter((path) => input.read(path) !== undefined);
    const ids = entries.filter((entry) => IMPLEMENTATION_STATUSES.includes(entry.status)).map((entry) => entry.id);

    if (section === undefined) {
      problems.push(`${document.name}: ${ids.join(', ')} claim an implementation but the document has no "${SECTION_SHAPE}" section`);
    } else if (existing.length === 0) {
      problems.push(
        `${document.name}: ${ids.join(', ')} claim an implementation but ${SECTION_SHAPE} cites no existing source file`,
      );
    }
  }

  if (claimsTests) {
    const section = parseSection(document.text, TEST_SECTION);
    const cited = section === undefined ? [] : parseReferencedPaths(section, 'tests/');
    const existing = cited.filter((path) => input.read(path) !== undefined);
    const ids = entries.filter((entry) => TESTED_STATUSES.includes(entry.status)).map((entry) => entry.id);

    if (section === undefined) {
      problems.push(`${document.name}: ${ids.join(', ')} claim tested behaviour but the document has no "${TEST_SECTION}" section`);
    } else if (existing.length === 0) {
      problems.push(
        `${document.name}: ${ids.join(', ')} claim tested behaviour but ${TEST_SECTION} cites no existing test file`,
      );
    }
  }

  return problems;
}

/**
 * Both directions of the route comparison, keyed by method **and** path.
 *
 * A route documented with the wrong verb is the failure a path-only check cannot
 * see: the URL is right, the table looks right, and the handler a caller reaches
 * is a different one.
 */
function checkRoutes(documented: ReadonlySet<string>, mounted: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const mountedByPath = new Map<string, Set<string>>();

  for (const key of mounted) {
    const [method, path] = splitRouteKey(key);
    const methods = mountedByPath.get(path) ?? new Set<string>();
    methods.add(method);
    mountedByPath.set(path, methods);
  }

  for (const key of documented) {
    if (mounted.has(key)) continue;
    const [method, path] = splitRouteKey(key);
    const otherMethods = mountedByPath.get(path);
    problems.push(
      otherMethods
        ? `documented route is not mounted: ${key} (${path} answers ${[...otherMethods].sort().join(', ')})`
        : `documented route is not mounted: ${key}`,
    );
  }

  for (const key of mounted) {
    if (!documented.has(key)) problems.push(`mounted route is not documented: ${key}`);
  }

  return problems;
}

/** `"GET /v1/agents/{}"` → `['GET', '/v1/agents/{}']`. */
function splitRouteKey(key: string): [string, string] {
  const space = key.indexOf(' ');
  return [key.slice(0, space), key.slice(space + 1)];
}

/**
 * A capability's status against the composition that decides it.
 *
 * Three states, one expected status each: unwired is anything but `supported`,
 * wired with a live blocker is `partial`, and wired with no recorded blocker is
 * `supported`. Letting any pair disagree is how a `partial` outlives the gap it
 * described, or a `supported` is published for behaviour a caller still cannot
 * reach.
 */
function checkProductionWiring(
  entries: readonly CapabilityEntry[],
  wiring: Readonly<Record<string, WiringRequirement>>,
  read: (path: string) => string | undefined,
): string[] {
  const problems: string[] = [];

  for (const [id, requirement] of Object.entries(wiring)) {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) {
      problems.push(`production wiring is recorded for unknown capability: ${id}`);
      continue;
    }
    const text = read(requirement.file);
    const wired = text !== undefined && text.includes(requirement.symbol);
    const blocker = requirement.blocker;
    const blocked = blocker !== undefined
      && (read(blocker.file) ?? '').includes(blocker.symbol);

    if (!wired) {
      if (entry.status === 'supported') {
        problems.push(
          `${id} is "supported" but no runtime composition uses ${requirement.symbol} in ${requirement.file}`,
        );
      }
      continue;
    }

    if (blocked && entry.status !== 'partial') {
      problems.push(
        `${id} is "${entry.status}" while ${blocker.detail}; ${blocker.file} still pins it, so the status is not "partial"`,
      );
    }
    if (!blocked && entry.status !== 'supported') {
      problems.push(
        `${id} is "${entry.status}" but ${requirement.file} wires ${requirement.symbol} and no recorded blocker remains; raise the status to "supported"`,
      );
    }
  }

  return problems;
}
