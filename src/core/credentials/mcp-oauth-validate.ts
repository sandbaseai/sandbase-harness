/**
 * Live credential validation — the `mcp_oauth_validate` endpoint's probe.
 *
 * The published endpoint answers one question: does the stored credential
 * authenticate against the MCP server it is bound to? The answer is a
 * `vault_credential_validation` object carrying `status`
 * (`valid` / `invalid` / `unknown`), the failing handshake step under
 * `mcp_probe`, and the refresh exchange a 401 triggered under `refresh`.
 *
 * The probe is the same `initialize` handshake a session connect runs: the
 * MCP `Client` over `SSEClientTransport`, with the credential's secret riding
 * the `Authorization` header exactly the way the injection boundary attaches
 * it. The fetch the transport runs is wrapped so the last HTTP response is
 * captured into the published `http_response` shape — status, content type,
 * and a truncated body with every secret the exchange carried scrubbed.
 *
 * Verdict discipline mirrors the published contract:
 *
 * - `valid` only when the handshake completes; a 200 with no handshake is not
 *   success.
 * - `invalid` when the server answered and rejected — 4xx the retry class
 *   cannot recover, including a 401 whose refresh did not help.
 * - `unknown` for everything transient: DNS/TLS/timeout, 5xx, and 429 — the
 *   credential may be fine and the probe cannot prove otherwise.
 * - A 401 attempts the refresh exchange once; its outcome is reported under
 *   `refresh`, and a success re-probes once.
 *
 * The credential's own `network` policy governs the probe exactly the way it
 * governs injection: an `allowed_hosts` list that does not cover the declared
 * server host refuses the probe before the secret is decrypted, because a
 * policy that would deny the real connect cannot be stepped around by the
 * diagnostic that reports it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Database } from '@/core/db/database.js';
import { decryptSecret } from '@/core/security/secrets.js';
import { appendCredentialAuditEvent } from './audit.js';
import { parseOAuthState } from './canonical-credential.js';
import { authorizeCredentialNetwork, parseCredentialNetworkPolicy } from './policy.js';
import {
  captureHttpResponse,
  refreshMcpOauthCredentialForValidation,
  type CapturedHttpResponse,
  type CredentialRow,
  type ValidationRefreshOutcome,
} from './oauth-refresh.js';

/** One probe must not outlive the patience of the request that asked for it. */
export const MCP_VALIDATE_TIMEOUT_MS = 15_000;

/** The published `mcp_probe` shape: the handshake step that failed. */
export interface McpProbeReport {
  method: 'initialize';
  http_response: CapturedHttpResponse | null;
}

/** The published `refresh` shape: the exchange a 401 probe triggered. */
export interface ValidationRefreshReport {
  status: ValidationRefreshOutcome['status'];
  http_response: CapturedHttpResponse | null;
}

export interface CredentialValidationResult {
  status: 'valid' | 'invalid' | 'unknown';
  has_refresh_token: boolean;
  mcp_probe: McpProbeReport | null;
  refresh: ValidationRefreshReport | null;
  validated_at: string;
}

export type McpCredentialValidation =
  | { ok: true; result: CredentialValidationResult }
  | { ok: false; message: string; code?: string };

export interface McpCredentialValidationOptions {
  /** Workspace data directory for secret decryption. */
  dataDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  /** Webhook publisher for a refresh failure, matching the boundary refresher. */
  publish?: (event: { type: string; subjectId: string; extra?: Record<string, unknown> }) => Promise<void> | void;
}

/** A row carrying the columns the probe and the refresh need. */
export type ValidatableCredentialRow = CredentialRow & {
  auth_type: string;
  network: string | null;
  injection_locations: string | null;
};

/**
 * Validate one stored credential against its declared `mcp_server_url`.
 *
 * `{ok: false}` is a precondition refusal — a credential that cannot lawfully
 * be probed at all — not a verdict: the route answers it as a request error
 * rather than publishing a status the probe never reached.
 */
export async function validateMcpCredential(
  db: Database,
  row: ValidatableCredentialRow,
  opts: McpCredentialValidationOptions = {},
): Promise<McpCredentialValidation> {
  if (row.auth_type !== 'mcp_oauth' && row.auth_type !== 'bearer_token') {
    return { ok: false, message: `credential type "${row.auth_type}" is not bound to an MCP server and cannot be probed` };
  }
  if (!row.mcp_server_url) {
    return { ok: false, message: 'credential declares no mcp_server_url to probe' };
  }
  let serverUrl: URL;
  try {
    serverUrl = new URL(row.mcp_server_url);
  } catch {
    return { ok: false, message: 'credential mcp_server_url is not a valid URL' };
  }

  // The same gate the injection boundary applies before decrypting: the
  // credential's own `allowed_hosts` must cover the host the token would be
  // sent to. A diagnostic is not an exemption — sending the secret anyway
  // would violate the policy the probe is supposed to honour.
  const authorization = authorizeCredentialNetwork(
    parseCredentialNetworkPolicy(row.network),
    row.mcp_server_url,
  );
  if (!authorization.allowed) {
    return { ok: false, message: authorization.message ?? 'credential network policy denies the declared server host', code: authorization.code };
  }

  // The keyed credential's injection rule limits the secret to the request
  // header; a record that explicitly excludes that channel can never
  // authenticate a connect, so a probe has nothing to measure.
  const locations = parseStringArray(row.injection_locations);
  const headerAllowed = locations.length === 0 || locations.includes('request_headers');
  if (!headerAllowed) {
    return { ok: false, message: 'credential injection policy does not permit request_headers, the only channel an MCP probe can authenticate on' };
  }

  const accessToken = decryptAccessToken(row, opts.dataDir);
  if (!accessToken) {
    return { ok: false, message: 'stored access token could not be decrypted; the credential cannot be probed' };
  }

  const oauthState = row.auth_type === 'mcp_oauth' ? parseOAuthState(row.oauth_state) : {};
  const hasRefreshToken = row.auth_type === 'mcp_oauth' && Boolean(oauthState.hasRefreshToken);
  const secrets = [accessToken];

  const first = await runInitializeProbe(serverUrl, accessToken, secrets, opts);
  let probe = first;
  let refresh: ValidationRefreshReport | null = null;

  if (!first.ok && first.httpResponse?.status_code === 401) {
    // Rejected credentials get one recovery attempt before the verdict: the
    // published `refresh` object records the exchange (or explains why none
    // could run), and a success is re-probed once — the verdict answers the
    // token the caller actually holds afterwards.
    if (row.auth_type === 'mcp_oauth' && oauthState.tokenEndpoint && hasRefreshToken) {
      const outcome = await refreshMcpOauthCredentialForValidation(db, row, {
        dataDir: opts.dataDir,
        fetchImpl: opts.fetchImpl,
        now: opts.now,
        publish: opts.publish,
        scrubSecrets: secrets,
      });
      refresh = { status: outcome.status, http_response: outcome.httpResponse };
      if (outcome.status === 'succeeded') {
        const refreshed = decryptAccessToken(db.prepare(
          'SELECT secret_ciphertext, secret_nonce, secret_tag FROM credential_records WHERE id = ?',
        ).get(row.id) as Pick<ValidatableCredentialRow, 'secret_ciphertext' | 'secret_nonce' | 'secret_tag'>, opts.dataDir);
        if (refreshed) {
          secrets.push(refreshed);
          probe = await runInitializeProbe(serverUrl, refreshed, secrets, opts);
        }
      }
    } else {
      refresh = { status: 'no_refresh_token', http_response: null };
    }
  }

  const result: CredentialValidationResult = {
    status: verdictOf(probe, refresh),
    has_refresh_token: hasRefreshToken,
    mcp_probe: probe.ok ? null : { method: 'initialize', http_response: probe.httpResponse ?? null },
    refresh,
    validated_at: (opts.now ?? (() => new Date()))().toISOString(),
  };
  appendCredentialAuditEvent(db, {
    vaultId: row.vault_id,
    credentialId: row.id,
    action: 'validate',
    actor: 'runtime',
    metadata: { status: result.status, method: 'initialize' },
  });
  return { ok: true, result };
}

type ProbeOutcome = { ok: true } | { ok: false; httpResponse: CapturedHttpResponse | null };

/**
 * Run the `initialize` handshake once against the declared server.
 *
 * The wrapping fetch is what makes the outcome reportable: it attaches the
 * Authorization header on every leg (the SSE open and the message POSTs, the
 * same two channels the session transport uses) and captures the last
 * non-2xx response so a rejection carries its wire evidence. Only non-2xx
 * bodies are read — a successful SSE stream never terminates, so reading it
 * would hang the probe.
 */
async function runInitializeProbe(
  serverUrl: URL,
  accessToken: string,
  secrets: string[],
  opts: McpCredentialValidationOptions,
): Promise<ProbeOutcome> {
  let captured: CapturedHttpResponse | null = null;
  const wrappedFetch: typeof fetch = async (input, init) => {
    // `init.headers` arrives as a Headers instance, not a plain object — a
    // spread would drop the transport's own Accept/protocol headers.
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${accessToken}`);
    const response = await (opts.fetchImpl ?? fetch)(input, { ...init, headers });
    if (!response.ok) {
      const bodyText = await readBodyBounded(response.clone());
      captured = captureHttpResponse(response, bodyText, secrets);
    }
    return response;
  };

  const transport = new SSEClientTransport(serverUrl, { fetch: wrappedFetch });
  const client = new Client({ name: 'sandbase-harness', version: '1.0.0' });
  try {
    await withTimeout(
      client.connect(transport),
      opts.timeoutMs ?? MCP_VALIDATE_TIMEOUT_MS,
      'MCP initialize handshake timed out',
    );
    return { ok: true };
  } catch {
    return { ok: false, httpResponse: captured };
  } finally {
    // A hung or half-open transport must not outlive the probe: `close` aborts
    // the SSE stream and the underlying fetch.
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

/**
 * Read an error response body with a hard bound: a misbehaving endpoint that
 * streams forever cannot stall the probe on a body read. The bound is loose
 * enough for any realistic error payload — `captureHttpResponse` truncates to
 * 4 KB anyway.
 */
async function readBodyBounded(response: Response): Promise<string> {
  try {
    const text = await withTimeout(response.text(), 3_000, 'body read timed out');
    return text.slice(0, 16_000);
  } catch {
    return '';
  }
}

/** Map the probe (and any refresh it triggered) onto the published verdict. */
function verdictOf(probe: ProbeOutcome, refresh: ValidationRefreshReport | null): 'valid' | 'invalid' | 'unknown' {
  if (probe.ok) return 'valid';
  const status = probe.httpResponse?.status_code;
  if (status === undefined) return 'unknown'; // no response: DNS, TLS, timeout
  // The transport refused a redirect before the target could authenticate the
  // credential. That establishes an endpoint problem, not an invalid token.
  if (status >= 300 && status < 400) return 'unknown';
  if (status === 429 || status >= 500) return 'unknown'; // transient
  if (refresh?.status === 'connect_error') return 'unknown';
  if (refresh?.status === 'failed' && refresh.http_response
    && (refresh.http_response.status_code === 429 || refresh.http_response.status_code >= 500)) {
    return 'unknown'; // the recovery path hit the transient class
  }
  return 'invalid';
}

function decryptAccessToken(
  row: Pick<ValidatableCredentialRow, 'secret_ciphertext' | 'secret_nonce' | 'secret_tag'>,
  dataDir?: string,
): string {
  if (!row.secret_ciphertext || !row.secret_nonce || !row.secret_tag) return '';
  try {
    return decryptSecret({ ciphertext: row.secret_ciphertext, nonce: row.secret_nonce, tag: row.secret_tag }, dataDir);
  } catch {
    return '';
  }
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
