/**
 * The environment a git child is given must carry no tracing switch.
 *
 * This is a security invariant, not a tidiness one. The token reaches git as the
 * `Authorization: Basic` header inside `GIT_CONFIG_VALUE_0`, and a trace is one
 * host variable away from printing it: git redacts that header by default
 * (`Authorization: Basic <redacted>`, measured on git 2.55), and prints the
 * base64 form once `GIT_TRACE_REDACT=false` joins the same environment — while
 * trace2's `configparams` dump is not redacted at all. `GIT_CURL_VERBOSE` is the
 * trap that motivated this file: git reads it for its *presence*, so the empty
 * string an earlier revision set disabled nothing and enabled the trace.
 *
 * The rule under test is the family, not a list of names, because git documents
 * more tracing switches than any list here would hold: `GIT_TRACE_REFS=1` wrote
 * 52 trace lines for a local clone and `GIT_TRACE_PACKFILE=<file>` wrote a pack
 * file on git 2.55.0.windows.5, and neither was in the list the first revision
 * shipped. The case below that passes those names is the one that fails when the
 * implementation goes back to naming switches one by one.
 *
 * The behavioural half lives in `tests/integration/github-git-trace.test.ts`,
 * which needs no network and no credential: a refused loopback connection still
 * makes curl write its trace, so the absence of that trace is asserted against
 * real git.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { gitAuthEnv } from '@/core/resources/github-materializer.js';
import { gitChildEnv, isGitTraceEnvName } from '@/core/resources/github-runtime.js';

/** Names the assertions below treat as "a tracing switch". */
const TRACE_PATTERN = /^(GIT_TRACE|GIT_TRACE2|GIT_CURL_VERBOSE)/;

/**
 * Tracing switches git 2.55 documents that the first revision of this guard did
 * not name. At least `GIT_TRACE_REFS` and `GIT_TRACE_PACKFILE` were measured to
 * write output; all of them must be stripped by the family rule.
 */
const DOCUMENTED_SWITCHES = [
  'GIT_TRACE_REFS',
  'GIT_TRACE_PACKFILE',
  'GIT_TRACE_FSMONITOR',
  'GIT_TRACE2_BRIEF',
  'GIT_TRACE2_EVENT_BRIEF',
  'GIT_TRACE2_EVENT_NESTING',
  'GIT_TRACE2_PERF_BRIEF',
];

const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

/** Set a variable on the parent environment, remembering what to restore. */
function setInParent(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

describe('git child environment', () => {
  it('inherits the parent environment, because git needs PATH and its own install variables', () => {
    const env = gitChildEnv();
    expect(env.PATH ?? env.Path).toBeTruthy();
  });

  it('removes every tracing switch the host exported', () => {
    setInParent('GIT_TRACE', '1');
    setInParent('GIT_TRACE2_EVENT', '1');
    // The one that started this: an empty value still traces, because git reads
    // the variable for its presence.
    setInParent('GIT_CURL_VERBOSE', '');
    setInParent('GIT_TRACE_REDACT', 'false');

    const env = gitChildEnv();
    expect(Object.keys(env).filter((name) => TRACE_PATTERN.test(name))).toEqual([]);
  });

  it('removes a tracing switch even when a caller passes one, because the token is in that environment', () => {
    const env = gitChildEnv({ GIT_CURL_VERBOSE: '1', KEEP_ME: 'yes' });

    expect(env.GIT_CURL_VERBOSE).toBeUndefined();
    // A caller-supplied variable that is not a tracing switch still arrives: the
    // strip is about tracing, not about overriding the caller.
    expect(env.KEEP_ME).toBe('yes');
  });

  it('matches a tracing switch whatever its casing, because the Windows environment does', () => {
    // Measured on git 2.55.0.windows.5: `git_curl_verbose=1` and
    // `Git_Curl_Verbose=1` both trace, so an exact-name match would leave a
    // one-character-different variable as a way around the strip.
    setInParent('git_curl_verbose', '1');
    setInParent('Git_Trace2_Event', '1');

    const env = gitChildEnv({ gIt_CuRl_VeRbOsE: '1' });
    expect(Object.keys(env).map((name) => name.toUpperCase()).filter((name) => TRACE_PATTERN.test(name)))
      .toEqual([]);
  });

  it('removes a documented switch this code was never taught about, because the rule is the family', () => {
    // A list-based guard passes the two cases above and fails this one: every
    // name here is a real git tracing switch that the shipped list omitted.
    const passed = Object.fromEntries(DOCUMENTED_SWITCHES.map((name) => [name, '1']));
    const env = gitChildEnv({ ...passed, KEEP_ME: 'yes' });

    for (const name of DOCUMENTED_SWITCHES) expect(env[name]).toBeUndefined();
    expect(Object.keys(env).filter((name) => TRACE_PATTERN.test(name))).toEqual([]);
    expect(env.KEEP_ME).toBe('yes');
  });

  it('classifies a name by its family, and only by its family', () => {
    for (const name of DOCUMENTED_SWITCHES) expect(isGitTraceEnvName(name)).toBe(true);
    for (const name of ['GIT_CURL_VERBOSE', 'GIT_TRACE', 'GIT_TRACE2', 'git_trace_refs']) {
      expect(isGitTraceEnvName(name)).toBe(true);
    }
    // Variables git does not trace with keep working, including ones whose names
    // merely start with GIT_.
    for (const name of ['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GIT_CONFIG_COUNT', 'KEEP_ME', 'PATH']) {
      expect(isGitTraceEnvName(name)).toBe(false);
    }
  });

  it('leaves a credential-bearing environment otherwise intact', () => {
    const env = gitChildEnv(gitAuthEnv('ghp_example_token'));

    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraheader');
    const header = env.GIT_CONFIG_VALUE_0 ?? '';
    expect(Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString('utf8'))
      .toBe('x-access-token:ghp_example_token');
    // Interactive prompting stays off: an unauthorized clone must fail, not hang.
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(Object.keys(env).filter((name) => TRACE_PATTERN.test(name))).toEqual([]);
  });
});
