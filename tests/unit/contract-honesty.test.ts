/**
 * The contract honesty guard.
 *
 * Four descriptions of one build have to agree: the capability matrix, the
 * prose under `contracts/anthropic-cma/`, the test and source files those
 * contracts name, and the routes the server actually mounts. Two of the drifts
 * this guard catches were live in the tree before it existed — a contract that
 * credited a real test file with covering runtime wiring that test never
 * touched, and a matrix entry that reported `supported` for a capability whose
 * implementation no runtime composition ever injected. Both read as green.
 *
 * The rules live in `./support/contract-honesty.ts` and run here twice: once
 * against the repository, where a single problem fails the suite, and once
 * against fixtures that must fail, so the guard cannot pass by finding nothing.
 * Requirement 8 of the work item is that second half: a check nobody has watched
 * fail is a check that may not work.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CMA_CAPABILITY_MATRIX,
  type CapabilityEntry,
} from '@/core/capabilities/matrix.js';
import {
  COMPAT_TABLE_END,
  COMPAT_TABLE_START,
  renderCompatibilityTable,
} from '@/core/capabilities/compat-table.js';
import {
  PRODUCTION_WIRING,
  checkContractHonesty,
  parseDocumentedRoutes,
  parseReferencedPaths,
  parseStatusBlock,
  type ContractDocument,
  type WiringRequirement,
} from './support/contract-honesty';
import { mountedRouteKeys, routeKey } from './support/route-table';

const CONTRACTS_DIR = resolve(process.cwd(), 'contracts', 'anthropic-cma');

/** Text of a repository-relative file, or `undefined` when nothing is there. */
function readRepoFile(path: string): string | undefined {
  try {
    return readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch {
    return undefined;
  }
}

function contractDocuments(): ContractDocument[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name, text: readFileSync(resolve(CONTRACTS_DIR, name), 'utf8') }));
}

function repoProblems(): string[] {
  return checkContractHonesty({
    entries: CMA_CAPABILITY_MATRIX,
    documents: contractDocuments(),
    read: readRepoFile,
    mountedRouteKeys: mountedRouteKeys(),
  });
}

function documentNamed(name: string, documents = contractDocuments()): ContractDocument {
  const document = documents.find((candidate) => candidate.name === name);
  if (!document) throw new Error(`No contract document named ${name}`);
  return document;
}

function entry(id: string): CapabilityEntry {
  const found = CMA_CAPABILITY_MATRIX.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No capability entry named ${id}`);
  return found;
}

/** One route-table row, in the shape the guard reads. */
function routeRow(method: string, path: string): string {
  return `| ${method} | \`${path}\` | \`src/demo.ts\` |`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEMO_ENTRY: CapabilityEntry = {
  area: 'agents',
  id: 'demo',
  status: 'supported',
  reason: 'A fixture entry.',
  contract: 'contracts/anthropic-cma/demo.md',
};

const DEMO_TEXT = [
  'Demo contract.',
  '',
  '<!-- capability-status',
  'demo: supported',
  '-->',
  '',
  '## 1. Official definition',
  '',
  'The published behaviour.',
  '',
  '## 2. Current SandBase shape',
  '',
  'Implemented in `src/demo.ts`.',
  '',
  '## 3. Alignment',
  '',
  'Aligned for the local shape.',
  '',
  '## 4. Differences',
  '',
  'None.',
  '',
  '## 5. Reason for the difference',
  '',
  'None.',
  '',
  '## 6. Corresponding tests',
  '',
  '`tests/unit/demo.test.ts` covers the behaviour.',
  '',
  '## 7. Status',
  '',
  '`supported`.',
].join('\n');

interface FixtureOptions {
  entries?: CapabilityEntry[];
  documents?: ContractDocument[];
  files?: Record<string, string>;
  routes?: string[];
  wiring?: Record<string, WiringRequirement>;
}

function fixtureProblems(options: FixtureOptions = {}): string[] {
  const files = options.files ?? {
    'src/demo.ts': 'export const demo = true;',
    'tests/unit/demo.test.ts': "it('works', () => {});",
    'contracts/anthropic-cma/demo.md': DEMO_TEXT,
  };
  return checkContractHonesty({
    entries: options.entries ?? [DEMO_ENTRY],
    documents: options.documents ?? [{ name: 'demo.md', text: DEMO_TEXT }],
    read: (path) => files[path],
    mountedRouteKeys: new Set(options.routes ?? []),
    wiring: options.wiring ?? {},
  });
}

/** One problem that must mention `needle`, from a fixture that is otherwise valid. */
function expectProblem(needle: string | RegExp, options: FixtureOptions = {}): void {
  const problems = fixtureProblems(options);
  expect(problems.join('\n')).toMatch(needle);
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

describe('contract honesty', () => {
  it('holds the matrix, the contracts, and the mounted routes to the same facts', () => {
    // A single string makes a failure read as the list of disagreements rather
    // than as an opaque array diff.
    expect(repoProblems().join('\n')).toBe('');
  });

  it('compares routes by method and path rather than by path alone', () => {
    const documented = new Set(parseDocumentedRoutes(documentNamed('routes.md').text));
    const mounted = mountedRouteKeys();

    expect(documented.size).toBeGreaterThan(100);
    expect([...documented].sort()).toEqual([...mounted].sort());
  });

  it('declares a machine-readable status for every matrix entry, once', () => {
    for (const document of contractDocuments()) {
      const declared = parseStatusBlock(document.text).statuses;
      const cited = CMA_CAPABILITY_MATRIX.filter(
        (candidate) => candidate.contract === `contracts/anthropic-cma/${document.name}`,
      );
      if (cited.length === 0) {
        expect(declared.size, `${document.name} declares statuses but no entry cites it`).toBe(0);
        continue;
      }
      expect([...declared.keys()].sort(), `${document.name} status block`).toEqual(
        cited.map((candidate) => candidate.id).sort(),
      );
    }
  });

  it('keeps the README compatibility tables identical to the rendered matrix', () => {
    for (const name of ['README.md', 'README.zh-CN.md']) {
      const readme = readRepoFile(name) ?? '';
      const start = readme.indexOf(COMPAT_TABLE_START);
      const end = readme.indexOf(COMPAT_TABLE_END);
      expect(start, `${name} compat-table start marker`).toBeGreaterThanOrEqual(0);
      expect(end, `${name} compat-table end marker`).toBeGreaterThan(start);
      const published = readme.slice(start + COMPAT_TABLE_START.length, end).trim();
      // Drift is fixed by `npm run docs:compat`, never by editing the table.
      expect(published, name).toBe(renderCompatibilityTable(CMA_CAPABILITY_MATRIX));
    }
  });

  it('names only source and test files that exist', () => {
    for (const document of contractDocuments()) {
      for (const path of [
        ...parseReferencedPaths(document.text, 'src/'),
        ...parseReferencedPaths(document.text, 'tests/'),
      ]) {
        expect(readRepoFile(path), `${document.name} cites ${path}`).toBeTypeOf('string');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The guard's own teeth
// ---------------------------------------------------------------------------

describe('contract honesty guard', () => {
  it('accepts a fixture that is internally consistent', () => {
    expect(fixtureProblems()).toEqual([]);
  });

  it('fails when a contract path does not exist', () => {
    expectProblem(/cites a contract file that does not exist/, {
      files: { 'src/demo.ts': '', 'tests/unit/demo.test.ts': '' },
    });
  });

  it('fails when a contract sits outside the contract directory', () => {
    expectProblem(/cites a contract outside/, {
      entries: [{ ...DEMO_ENTRY, contract: 'docs/demo.md' }],
    });
  });

  it('fails when two entries reuse an id', () => {
    expectProblem(/id is not unique: demo/, { entries: [DEMO_ENTRY, DEMO_ENTRY] });
  });

  it('fails when a document has no status block', () => {
    expectProblem(/no <!-- capability-status --> block/, {
      documents: [{ name: 'demo.md', text: 'No block here.' }],
    });
  });

  it('fails when the status block disagrees with the matrix', () => {
    expectProblem(/status block says demo is "partial" but the matrix says "supported"/, {
      documents: [
        { name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo: partial') },
      ],
    });
  });

  it('fails when the status block omits an entry that cites the document', () => {
    expectProblem(/status block omits demo \(supported\)/, {
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'other: partial') }],
    });
  });

  it('fails when the status block declares an entry that does not cite the document', () => {
    expectProblem(/does not cite this file/, {
      documents: [
        { name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo: supported\nghost: partial') },
      ],
    });
  });

  it('fails on an unparsable status line and on an unknown status', () => {
    expectProblem(/unparsable line: "demo supported"/, {
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo supported') }],
    });
    expectProblem(/unknown status "sort_of"/, {
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo: sort_of') }],
    });
  });

  it('fails when a cited test file does not exist', () => {
    expectProblem(/cites a test file that does not exist: tests\/unit\/demo.test.ts/, {
      files: {
        'src/demo.ts': '',
        'contracts/anthropic-cma/demo.md': DEMO_TEXT,
      },
    });
  });

  it('fails when a cited source file does not exist', () => {
    expectProblem(/cites a source file that does not exist: src\/demo.ts/, {
      files: {
        'tests/unit/demo.test.ts': '',
        'contracts/anthropic-cma/demo.md': DEMO_TEXT,
      },
    });
  });

  it('fails when a capability claims an implementation but §2 cites no source file', () => {
    expectProblem(/claim an implementation but ## 2\. Current SandBase shape cites no existing source file/, {
      documents: [
        {
          name: 'demo.md',
          text: DEMO_TEXT
            .replace('<!-- capability-status\ndemo: supported\n-->', '<!-- capability-status\ndemo: partial\n-->')
            .replace('Implemented in `src/demo.ts`.', 'Nothing is implemented.'),
        },
      ],
      entries: [DEMO_ENTRY],
    });
  });

  it('fails when the evidence a status needs sits outside the section that makes the claim', () => {
    // A file named in a difference table is a citation, not evidence: §2 is the
    // section that says what exists.
    expectProblem(/claim an implementation but ## 2\..*cites no existing source file/, {
      documents: [
        {
          name: 'demo.md',
          text: DEMO_TEXT
            .replace('<!-- capability-status\ndemo: supported\n-->', '<!-- capability-status\ndemo: partial\n-->')
            .replace('Implemented in `src/demo.ts`.', 'Nothing is implemented.')
            .replace('None.', 'The published shape lives in `src/demo.ts`.'),
        },
      ],
      entries: [DEMO_ENTRY],
    });
  });

  it('fails when a document has no implementation or no tests section at all', () => {
    expectProblem(/claim an implementation but the document has no "## 2\. Current SandBase shape" section/, {
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('## 2. Current SandBase shape', '## 2. Shape') }],
    });
    expectProblem(/claim tested behaviour but the document has no "## 6\. Corresponding tests" section/, {
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('## 6. Corresponding tests', '## 6. Tests') }],
    });
  });

  it('fails when a capability claims tested behaviour but §6 cites no test file', () => {
    expectProblem(/claim tested behaviour but ## 6\. Corresponding tests cites no existing test file/, {
      documents: [
        { name: 'demo.md', text: DEMO_TEXT.replace('`tests/unit/demo.test.ts` covers the behaviour.', 'No test exercises it yet.') },
      ],
    });
  });

  it('fails when a documented route is not mounted, and names the verb that is', () => {
    expectProblem(/documented route is not mounted: GET \/v1\/demo/, {
      documents: [{ name: 'demo.md', text: `${DEMO_TEXT}\n${routeRow('GET', '/v1/demo')}` }],
    });
    expectProblem(/documented route is not mounted: POST \/v1\/demo \(\/v1\/demo answers GET\)/, {
      documents: [{ name: 'demo.md', text: `${DEMO_TEXT}\n${routeRow('POST', '/v1/demo')}` }],
      routes: ['GET /v1/demo'],
    });
  });

  it('fails when a mounted route is not documented', () => {
    expectProblem(/mounted route is not documented: GET \/v1\/demo/, { routes: ['GET /v1/demo'] });
  });

  it('fails when a supported capability is not wired into any runtime composition', () => {
    expectProblem(/is "supported" but no runtime composition uses missingSymbol/, {
      wiring: { demo: { file: 'src/demo.ts', symbol: 'missingSymbol' } },
    });
  });

  it('fails when a capability becomes reachable but keeps its lower status', () => {
    expectProblem(/raise the status to "supported"/, {
      entries: [{ ...DEMO_ENTRY, status: 'partial' }],
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo: partial') }],
      wiring: { demo: { file: 'src/demo.ts', symbol: 'demo' } },
    });
  });

  it('fails when a recorded blocker is gone and the status has not moved', () => {
    // The blocker is declared but its canary no longer pins anything, so the
    // reason this capability was `partial` has been fixed.
    expectProblem(/no recorded blocker remains; raise the status to "supported"/, {
      entries: [{ ...DEMO_ENTRY, status: 'partial' }],
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo: partial') }],
      wiring: {
        demo: {
          file: 'src/demo.ts',
          symbol: 'demo',
          blocker: { file: 'tests/unit/demo.test.ts', symbol: 'still refuses the canonical root', detail: 'the demo backend refuses it' },
        },
      },
    });
  });

  it('accepts a wired capability whose recorded blocker is still pinned', () => {
    const problems = fixtureProblems({
      entries: [{ ...DEMO_ENTRY, status: 'partial' }],
      documents: [{ name: 'demo.md', text: DEMO_TEXT.replace('demo: supported', 'demo: partial') }],
      files: {
        'src/demo.ts': 'export const demo = true;',
        'tests/unit/demo.test.ts': "it('still refuses the canonical root', () => {});",
        'contracts/anthropic-cma/demo.md': DEMO_TEXT.replace('demo: supported', 'demo: partial'),
      },
      wiring: {
        demo: {
          file: 'src/demo.ts',
          symbol: 'demo',
          blocker: { file: 'tests/unit/demo.test.ts', symbol: 'still refuses the canonical root', detail: 'the demo backend refuses it' },
        },
      },
    });

    expect(problems.join('\n')).toBe('');
  });

  it('fails when a capability is supported while its recorded blocker is still pinned', () => {
    expectProblem(/is "supported" while the demo backend refuses it; tests\/unit\/demo\.test\.ts still pins it/, {
      files: {
        'src/demo.ts': 'export const demo = true;',
        'tests/unit/demo.test.ts': "it('still refuses the canonical root', () => {});",
        'contracts/anthropic-cma/demo.md': DEMO_TEXT,
      },
      wiring: {
        demo: {
          file: 'src/demo.ts',
          symbol: 'demo',
          blocker: { file: 'tests/unit/demo.test.ts', symbol: 'still refuses the canonical root', detail: 'the demo backend refuses it' },
        },
      },
    });
  });

  it('fails when wiring is recorded for a capability that does not exist', () => {
    expectProblem(/production wiring is recorded for unknown capability: ghost/, {
      wiring: { ghost: { file: 'src/demo.ts', symbol: 'demo' } },
    });
  });

  it('turns red when a real contract names a file that is one character off', () => {
    // The acceptance for this guard is that a deliberate typo in an existing
    // contract fails the suite, not that a synthetic fixture can fail. The real
    // documents are loaded and one character is changed.
    const tampered = contractDocuments().map((document) =>
      document.name === 'agents.md'
        ? { ...document, text: document.text.replace('`src/core/agent/update.ts`', '`src/core/agent/updates.ts`') }
        : document,
    );

    const problems = checkContractHonesty({
      entries: CMA_CAPABILITY_MATRIX,
      documents: tampered,
      read: readRepoFile,
      mountedRouteKeys: mountedRouteKeys(),
    });

    expect(problems.join('\n')).toMatch(/agents\.md: cites a source file that does not exist: src\/core\/agent\/updates\.ts/);
  });

  it('turns red when a documented route is given the wrong verb', () => {
    // A URL-keyed check would still be green here, which is why the guard keys
    // on method and path together.
    const tampered = contractDocuments().map((document) =>
      document.name === 'routes.md'
        ? { ...document, text: document.text.replace('| GET | `/v1/agents` |', '| PATCH | `/v1/agents` |') }
        : document,
    );

    const problems = checkContractHonesty({
      entries: CMA_CAPABILITY_MATRIX,
      documents: tampered,
      read: readRepoFile,
      mountedRouteKeys: mountedRouteKeys(),
    });

    const joined = problems.join('\n');
    expect(joined).toMatch(/documented route is not mounted: PATCH \/v1\/agents \(\/v1\/agents answers GET, POST\)/);
    expect(joined).toMatch(/mounted route is not documented: GET \/v1\/agents/);
  });

  it('turns red when a real status block is edited to disagree with the matrix', () => {
    const tampered = contractDocuments().map((document) =>
      document.name === 'threads.md'
        ? { ...document, text: document.text.replace('threads-and-coordinator: unavailable', 'threads-and-coordinator: partial') }
        : document,
    );

    const problems = checkContractHonesty({
      entries: CMA_CAPABILITY_MATRIX,
      documents: tampered,
      read: readRepoFile,
      mountedRouteKeys: mountedRouteKeys(),
    });

    expect(problems.join('\n')).toMatch(/threads\.md: status block says threads-and-coordinator is "partial" but the matrix says "unavailable"/);
  });

  it('has a guarded invariant for every rule the guard claims', () => {
    // Each negative fixture above is named here, so a rule that loses its
    // fixture fails loudly instead of quietly becoming untested.
    const ruleNames = [
      'fails when a contract path does not exist',
      'fails when a contract sits outside the contract directory',
      'fails when two entries reuse an id',
      'fails when a document has no status block',
      'fails when the status block disagrees with the matrix',
      'fails when the status block omits an entry that cites the document',
      'fails when the status block declares an entry that does not cite the document',
      'fails on an unparsable status line and on an unknown status',
      'fails when a cited test file does not exist',
      'fails when a cited source file does not exist',
      'fails when a capability claims an implementation but §2 cites no source file',
      'fails when the evidence a status needs sits outside the section that makes the claim',
      'fails when a document has no implementation or no tests section at all',
      'fails when a capability claims tested behaviour but §6 cites no test file',
      'fails when a documented route is not mounted, and names the verb that is',
      'fails when a mounted route is not documented',
      'fails when a supported capability is not wired into any runtime composition',
      'fails when a capability becomes reachable but keeps its lower status',
      'fails when a recorded blocker is gone and the status has not moved',
      'accepts a wired capability whose recorded blocker is still pinned',
      'fails when a capability is supported while its recorded blocker is still pinned',
      'fails when wiring is recorded for a capability that does not exist',
      'turns red when a real contract names a file that is one character off',
      'turns red when a documented route is given the wrong verb',
      'turns red when a real status block is edited to disagree with the matrix',
    ];

    const suite = readRepoFile('tests/unit/contract-honesty.test.ts') ?? '';
    for (const name of ruleNames) {
      expect(suite, `no test named "${name}"`).toContain(`it('${name}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('contract document parsing', () => {
  it('reads a status block and reports its absence', () => {
    const parsed = parseStatusBlock('<!-- capability-status\ndemo: partial\nother: unavailable\n-->');
    expect([...parsed.statuses]).toEqual([
      ['demo', 'partial'],
      ['other', 'unavailable'],
    ]);
    expect(parseStatusBlock('plain prose').present).toBe(false);
  });

  it('finds only backticked src and tests paths', () => {
    const text = 'See `src/a.ts`, `tests/unit/b.test.ts`, `docs/c.md`, and src/d.ts.';
    expect(parseReferencedPaths(text, 'src/')).toEqual(['src/a.ts']);
    expect(parseReferencedPaths(text, 'tests/')).toEqual(['tests/unit/b.test.ts']);
  });

  it('reads routes from tables only, never from prose', () => {
    const text = [
      'The published `GET /v1/sessions/{session_id}/threads` is not implemented here.',
      '',
      '| Method | Path | Registered by |',
      '| --- | --- | --- |',
      '| GET | `/v1/agents/{id}` | `src/api/routes/agents.ts` |',
      '| POST | `/v1/agents` | `src/api/routes/agents.ts` |',
    ].join('\n');

    expect(parseDocumentedRoutes(text)).toEqual([
      routeKey('GET', '/v1/agents/{}'),
      routeKey('POST', '/v1/agents'),
    ].sort());
  });

  it('ignores a fenced example of the conventions', () => {
    const block = '```\n<!-- capability-status\ndemo: partial\n-->\n```';
    expect(parseStatusBlock(block).present).toBe(false);
    expect(parseDocumentedRoutes('```\n| GET | `/v1/demo` | `src/demo.ts` |\n```')).toEqual([]);
    expect(parseReferencedPaths('```\n`src/demo.ts`\n```', 'src/')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The decisions this guard exists to keep honest
// ---------------------------------------------------------------------------

describe('documented capability decisions', () => {
  it('reports the canonical multiagent roster as unavailable and refuses it by name', () => {
    expect(entry('multiagent-roster').status).toBe('unavailable');
    expect(entry('threads-and-coordinator').status).toBe('unavailable');
    expect(entry('local-delegation-subagent').status).toBe('supported');

    const threads = documentNamed('threads.md').text;
    expect(threads).toContain('multiagent-roster');
    expect(parseDocumentedRoutes(threads)).toEqual([]);
  });

  it('reports Dreams as unavailable for the memory-consolidation pipeline it is', () => {
    expect(entry('dreams').status).toBe('unavailable');
    expect(entry('dreams').reason).toMatch(/memory-consolidation pipeline/);
    expect(entry('dreams').reason).toMatch(/does not implement/);
  });

  it('reports web_fetch execution as implemented with limits, and never as unavailable', () => {
    expect(entry('web-fetch-execution').status).toBe('partial');
    expect(entry('web-fetch-execution').reason).toMatch(/max_content_tokens/);

    // The drift this replaces was a tool table that listed `web_fetch` as
    // unavailable. A line may mention both words while keeping them apart (the
    // `web_search` rows do exactly that), so the check reads the row's own cell.
    const toolRow = /^\|\s*`web_fetch`\s*\|\s*([^|]+?)\s*\|/;
    for (const document of contractDocuments()) {
      for (const line of document.text.replace(/```[\s\S]*?```/g, '').split('\n')) {
        const row = toolRow.exec(line);
        if (row && !/^available/.test(row[1])) {
          throw new Error(`${document.name} lists web_fetch as: ${row[1].trim()}`);
        }
        if (/`web_fetch`( execution)? is `?unavailable/.test(line)) {
          throw new Error(`${document.name} still claims web_fetch is unavailable: ${line.trim()}`);
        }
      }
    }
  });

  it('leads the credential-injection deviation with plaintext and egress substitution', () => {
    const reason = entry('credential-injection-execution').reason;
    expect(entry('credential-injection-execution').status).toBe('partial');
    expect(reason).toMatch(/plaintext/);
    expect(reason).toMatch(/no opaque placeholder and no substitution at the network egress/);
    expect(documentNamed('credentials.md').text).toMatch(/plaintext/);
  });

  it('documents the shipped session.updated event in the sessions contract', () => {
    // `session.updated` was unimplemented for a while and this guard enforced
    // that every mention said so. It now ships through POST /v1/sessions/{id},
    // so the sessions contract must carry the event rather than the removal
    // note the old guard required.
    expect(documentNamed('sessions.md').text).toContain('session.updated');
  });

  it('does not report a capability as supported while its composition or its blocker says otherwise', () => {
    for (const [id, requirement] of Object.entries(PRODUCTION_WIRING)) {
      const wired = (readRepoFile(requirement.file) ?? '').includes(requirement.symbol);
      const blocker = requirement.blocker;
      const blocked = blocker !== undefined
        && (readRepoFile(blocker.file) ?? '').includes(blocker.symbol);
      // Both halves of the claim: the runtime reaches the code, and nothing
      // recorded still stops it.
      expect(entry(id).status === 'supported', `${id} wiring`).toBe(wired && !blocked);
    }
  });
});
