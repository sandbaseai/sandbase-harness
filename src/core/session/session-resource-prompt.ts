/**
 * The `# Session Resources` section of a session's system prompt.
 *
 * A session's resources are addressed by paths the runtime publishes: an attached
 * file lives at `/mnt/session/uploads/...`, a mounted repository at
 * `/workspace/<repo>`. The bytes are there, but the agent has no way to learn the
 * paths unless the instructions name them, so a mounted file it was never told
 * about is a mount it will not read.
 *
 * Two spellings matter, and they are not interchangeable:
 *
 * - the canonical path is what the runtime's file tools accept, on every backend;
 * - a shell command runs as an ordinary process, so on the local backend an
 *   absolute path resolves against the host filesystem rather than the sandbox.
 *   There the same file is named by the path relative to the sandbox root, which
 *   is what this section adds when the session's backend is `local`.
 *
 * Nothing here reads a credential. Only the fields the contract publishes are
 * rendered, a URL is stripped of any userinfo before it is printed, and an entry
 * whose shape is not understood — a mount path that is not a path, a checkout that
 * is not a shape this runtime writes, a value carrying a control character that
 * would end the bullet it belongs to — is skipped rather than guessed at or
 * rewritten, because an announced path that is not the exact path is worse than
 * silence.
 */

import { sandboxPathForStoredMountPath } from './file-mount-path.js';

/** Heading the section opens with, and the marker a test can assert on. */
export const SESSION_RESOURCES_HEADING = '# Session Resources';

export interface SessionResourcePromptOptions {
  /**
   * Backend the session's environment resolves to.
   *
   * `local` runs commands on the host, so the sandbox-relative spelling is added
   * there. A container backend's own root has the canonical path, and a
   * self-hosted worker owns its working directory, so neither gets the extra
   * spelling — telling an agent to use a relative path that does not exist is
   * worse than saying nothing.
   */
  sandboxProvider?: string;
}

/**
 * Render the section, or `undefined` when the session has no file or repository.
 *
 * Memory stores are deliberately not rendered here: they already have their own
 * section, and a mount described twice reads as two mounts.
 */
export function renderSessionResources(
  resources: ReadonlyArray<Record<string, unknown>> | undefined,
  options: SessionResourcePromptOptions = {},
): string | undefined {
  if (!resources || resources.length === 0) return undefined;

  const shellPaths = options.sandboxProvider === 'local';
  const lines: string[] = [];

  for (const resource of resources) {
    const type = typeof resource.type === 'string' ? resource.type : undefined;
    if (type === 'file') {
      const line = renderFileResource(resource, shellPaths);
      if (line) lines.push(line);
    } else if (type === 'github_repository') {
      const line = renderRepositoryResource(resource, shellPaths);
      if (line) lines.push(line);
    }
  }

  if (lines.length === 0) return undefined;
  return `${SESSION_RESOURCES_HEADING}\n\n${lines.join('\n')}`;
}

function renderFileResource(
  resource: Record<string, unknown>,
  shellPaths: boolean,
): string | undefined {
  const fileId = typeof resource.file_id === 'string' ? resource.file_id : '';
  let sandboxPath: string;
  try {
    // The same derivation the provisioning pass uses, so the path the agent is
    // told and the path the bytes were written to cannot disagree — including for
    // a row still carrying the pre-canonical spelling.
    sandboxPath = sandboxPathForStoredMountPath(resource.mount_path, fileId);
  } catch {
    return undefined;
  }
  if (!isSingleLine(sandboxPath)) return undefined;

  return `- File: \`${sandboxPath}\`${shellHint(sandboxPath, shellPaths)}`;
}

function renderRepositoryResource(
  resource: Record<string, unknown>,
  shellPaths: boolean,
): string | undefined {
  const url = displayUrl(typeof resource.url === 'string' ? resource.url : undefined);
  const mountPath = typeof resource.mount_path === 'string' ? resource.mount_path.trim() : '';
  if (!url || !isSingleLine(url) || !mountPath.startsWith('/') || !isSingleLine(mountPath)) {
    return undefined;
  }

  const checkout = describeCheckout(resource.checkout);
  return `- Repository: \`${url}\`, `
    + `${checkout ? `checkout: ${checkout}, ` : ''}`
    + `mounted at \`${mountPath}\`${shellHint(mountPath, shellPaths)}`;
}

/** The shell spelling of the same path, when the backend needs one. */
function shellHint(canonicalPath: string, shellPaths: boolean): string {
  if (!shellPaths) return '';
  const relative = relativeToSandbox(canonicalPath);
  return relative ? ` (in a shell, use \`${relative}\`)` : '';
}

/**
 * Describe the revision a mounted repository is at, or nothing at all.
 *
 * An absent checkout is not an unknown: the materializer resolves it to the
 * repository's default branch (`HEAD`), and saying so is more useful to an agent
 * than omitting the field. A checkout that is present but not a shape this
 * runtime writes is a different case — it is dropped rather than reported as the
 * default branch, which would describe a revision the session never asked for.
 */
function describeCheckout(value: unknown): string | undefined {
  if (value === undefined || value === null) return "the repository's default branch";
  if (typeof value === 'object') {
    const checkout = value as { type?: unknown; name?: unknown; sha?: unknown };
    if (checkout.type === 'branch' && isSingleLine(checkout.name)) {
      return `branch ${checkout.name}`;
    }
    if (checkout.type === 'commit' && isSingleLine(checkout.sha)) {
      return `commit ${checkout.sha}`;
    }
  }
  return undefined;
}

/**
 * The sandbox-relative spelling of a canonical in-sandbox path.
 *
 * Relative to the sandbox root — the working directory a command starts in — so
 * `/mnt/session/uploads/x` becomes `mnt/session/uploads/x`, not the logical `/x`
 * the caller declared, which names a path under the upload root rather than
 * under the sandbox.
 */
function relativeToSandbox(canonicalPath: string): string | undefined {
  const stripped = canonicalPath.replace(/^\/+/, '');
  if (stripped === '' || stripped.includes('..') || stripped.includes('\\')) return undefined;
  return stripped;
}

/**
 * Whether a stored value can be interpolated into the section unchanged.
 *
 * A control character — a newline most of all — would end the bullet it belongs to
 * and start an unattributed line of instruction, and collapsing it to a space
 * would announce a path that is not the path. So a value that is not a single
 * clean line disqualifies its entry instead.
 */
function isSingleLine(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim() !== ''
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * A URL safe to put in a prompt.
 *
 * The resource grammar admits only `https://github.com/<owner>/<repo>`, so a
 * credential cannot normally be here. This is the belt to that suspenders: if a
 * row written by something else carries userinfo, it is dropped rather than
 * printed, and a URL that cannot be parsed is printed only when it carries no
 * `@` at all.
 */
function displayUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return raw.includes('@') ? undefined : raw;
  }
}
