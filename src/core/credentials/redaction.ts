import type { CredentialInjectionBundle } from './injection.js';

/** A best-effort redactor whose retained secret values can be cleared after a turn. */
export interface SecretRedactor {
  (value: unknown): unknown;
  clear(): void;
}

/** Build a redactor from the ephemeral secret-bearing portions of a bundle. */
export function createCredentialRedactor(bundle?: CredentialInjectionBundle): SecretRedactor {
  return createSecretRedactor([
    ...Object.values(bundle?.environment ?? {}),
    ...Object.values(bundle?.request_headers ?? {}).map((value) => value.replace(/^Bearer\s+/i, '')),
    ...Object.values(bundle?.request_body ?? {}).filter((value): value is string => typeof value === 'string'),
  ]);
}

/** Build a redactor from raw values without exposing those values in its API. */
export function createSecretRedactor(values: Iterable<string>): SecretRedactor {
  const secrets = [...new Set([...values].filter((value) => value.length > 0))]
    .sort((a, b) => b.length - a.length);
  const redactor = ((value: unknown) => redactValue(value, secrets)) as SecretRedactor;
  redactor.clear = () => {
    secrets.fill('');
    secrets.length = 0;
  };
  return redactor;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]),
    );
  }
  return value;
}

/** Clear mutable secret-bearing fields in a bundle once the turn is complete. */
export function clearCredentialInjectionBundle(bundle?: CredentialInjectionBundle): void {
  if (!bundle) return;
  for (const key of Object.keys(bundle.environment)) delete bundle.environment[key];
  for (const key of Object.keys(bundle.request_headers)) delete bundle.request_headers[key];
  for (const key of Object.keys(bundle.request_body)) delete bundle.request_body[key];
}
