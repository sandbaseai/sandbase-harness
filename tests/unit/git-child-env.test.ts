/**
 * The environment a git child is given must carry no tracing switch.
 *
 * This is a security invariant, not a tidiness one. The token reaches git as the
 * `Authorization: Basic` header inside `GIT_CONFIG_VALUE_0`, and a curl trace
 * prints that header — in base64, which is not the string `sanitizeGitOutput`
 * replaces. `GIT_CURL_VERBOSE` is the trap that motivated this file: git reads it
 * for its *presence*, so the empty string an earlier revision set disabled
 * nothing and enabled the trace.
 *
 * The behavioural half lives in `tests/integration/github-git-trace.test.ts`, which
 * needs no network and no credential: a refused loopback connection still makes
 * curl write its trace, so the absence of that trace is asserted against real git.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { gitAuthEnv } from '@/core/resources/github-materializer.js';
import { GIT_TRACE_ENV_VARS, gitChildEnv } from '@/core/resources/github-runtime.js';

/** Names the assertions below treat as "a tracing switch". */
const TRACE_PATTERN = /^(GIT_TRACE|GIT_TRACE2|GIT_CURL_VERBOSE)/;

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

  it('names every switch it removes, so the list is the contract', () => {
    const passed = Object.fromEntries(GIT_TRACE_ENV_VARS.map((name) => [name, '1']));
    const env = gitChildEnv(passed);

    for (const name of GIT_TRACE_ENV_VARS) expect(env[name]).toBeUndefined();
    expect(GIT_TRACE_ENV_VARS).toContain('GIT_CURL_VERBOSE');
    expect(GIT_TRACE_ENV_VARS).toContain('GIT_TRACE');
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
