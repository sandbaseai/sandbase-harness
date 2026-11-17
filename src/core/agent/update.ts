/**
 * Agent update (POST/PUT) request contract.
 *
 * Both verbs carry the same partial-update semantics, deliberately: a `PUT`
 * that silently clears every field the body omitted is a data-loss path, and
 * the Console editor only ever shows a subset of the definition. The rules:
 *
 * - an omitted field keeps its stored value;
 * - a scalar that is present replaces its value;
 * - `tools`, `mcp_servers`, and `skills` replace wholesale when present;
 * - `metadata` merges per key, and an explicit `null` value deletes that key;
 * - `null` clears a clearable field — the same as `[]` for list fields;
 * - `system` clears to the empty string and `description` clears by removal;
 * - `name` and `model` can never be cleared;
 * - unknown fields are rejected, not silently discarded;
 * - the optimistic-concurrency precondition is accepted as either `version`
 *   (the published spelling) or `expected_version` (the local one).
 */

import { z } from 'zod';
import {
  agentModelConfigSchema,
  agentModelInputSchema,
  agentNameSchema,
  agentToolsetSchema,
  mcpServerConfigSchema,
  multiagentRosterRefusal,
  parseCoordinatorBlock,
  skillRefSchema,
  type ValidationError,
} from './schema.js';
import type { AgentDefinition } from '@/types/agent.js';

/**
 * Field names an update body may carry, besides the concurrency precondition.
 */
const UPDATE_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  name: agentNameSchema,
  model: agentModelInputSchema,
  system: z.union([z.string(), z.null()]),
  description: z.union([z.string(), z.null()]),
  model_config: z.union([agentModelConfigSchema, z.null()]),
  tools: z.union([z.array(agentToolsetSchema), z.null()]),
  mcp_servers: z.union([z.array(mcpServerConfigSchema), z.null()]),
  skills: z.union([z.array(skillRefSchema), z.null()]),
  metadata: z.union([z.record(z.string(), z.unknown()), z.null()]),
  max_turns: z.union([z.number().int().positive().max(1000), z.null()]),
  temperature: z.union([z.number().min(0).max(2), z.null()]),
  delegations: z.union([z.array(z.string()), z.null()]),
  // Internal provenance marker produced by the coordinator normalizer; accepted
  // here so the normalized update body validates. `null` clears it.
  delegations_source: z.union([z.literal('coordinator'), z.null()]),
  // The local delegation extension, accepted on this path for the same reason
  // the create path accepts it: the executor honours `enable_general_subagent`
  // when it builds the agent's delegation tools, so refusing it here would make
  // the two write paths disagree about a field the runtime does act on. It is a
  // local extension and is not the canonical `multiagent` roster, which stays
  // refused below.
  enable_general_subagent: z.union([z.boolean(), z.null()]),
  strategy: z.union([z.string(), z.null()]),
  environment: z.union([z.string(), z.null()]),
};

/**
 * Fields that reject an explicit `null` because clearing them would leave the
 * definition unresolvable: the model id selects the provider and the name is
 * the display identity. A clear attempt gets its own message rather than a
 * generic type error.
 */
const NON_CLEARABLE_FIELDS: Record<string, string> = {
  name: 'Agent name cannot be cleared; send a new name or omit the field',
  model: 'Agent model cannot be cleared; send a new model or omit the field',
};

export interface AgentUpdateRequest {
  /**
   * Present fields with their validated values. Key presence is the contract:
   * a key absent from this record was absent from (or unset in) the body.
   */
  fields: Record<string, unknown>;
  /**
   * `undefined` only when the body omitted the precondition entirely; a
   * malformed value, or two spellings that disagree, is a validation error.
   */
  expectedVersion?: number;
}

export type AgentUpdateRequestResult =
  | ({ valid: true } & AgentUpdateRequest)
  | { valid: false; errors: ValidationError[] };

/**
 * The two spellings of one precondition, in the order an error message names
 * them. `version` is the published name: the contract calls the field optional,
 * says supplying it gives optimistic concurrency control with a `409` on a
 * mismatch, and says omitting it applies the update unconditionally
 * (`定义您的智能体/智能体设置.md:350`), and the published update example sends it
 * (`:361`). `expected_version` is the local name for that same precondition.
 */
const PRECONDITION_FIELDS = ['expected_version', 'version'] as const;

/**
 * Parse one precondition value.
 *
 * A numeric string is accepted because the published example interpolates a
 * shell variable into the body, so the value can arrive as either type. Anything
 * else — including an empty string, a non-numeric string, a float, zero and a
 * negative — is `undefined`, which the caller turns into a validation error
 * rather than a silent downgrade to an unconditional update.
 */
function parsePrecondition(raw: unknown): number | undefined {
  const numeric = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? Number(raw)
      : Number.NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

/**
 * Read the concurrency precondition from either spelling.
 *
 * Both spellings name one thing, so sending both with **different** values is
 * refused rather than resolved by precedence: silently preferring one would apply
 * an update the other value said not to, which is exactly the lost write the
 * field exists to prevent. Sending both with the same value is accepted, because
 * there is then nothing to resolve.
 *
 * A present-but-malformed value is a validation error for the spelling that
 * carried it, for the same reason the local spelling has always been strict: a
 * client that meant to guard against lost writes must not get an unguarded one
 * from a typo.
 */
function resolvePrecondition(
  body: Record<string, unknown>,
  errors: ValidationError[],
): number | undefined {
  const present = PRECONDITION_FIELDS.filter((field) => field in body);
  if (present.length === 0) return undefined;

  const parsed = present.map((field) => ({ field, value: parsePrecondition(body[field]) }));
  let malformed = false;
  for (const { field, value } of parsed) {
    if (value === undefined) {
      errors.push({ path: field, message: `${field} must be a positive integer` });
      malformed = true;
    }
  }
  if (malformed) return undefined;

  if (new Set(parsed.map((entry) => entry.value)).size > 1) {
    errors.push({
      path: present[present.length - 1],
      message: '`version` and `expected_version` are the same precondition and disagree; '
        + 'send one of them, or send both with the same value',
    });
    return undefined;
  }

  return parsed[0].value;
}

/**
 * Validate an update request body against the partial-update contract.
 *
 * This validates each *present* field only; cross-field rules (MCP wiring,
 * custom tool uniqueness, roster cardinality) run against the merged
 * definition through `validateAgentDefinition`, so a request that changes one
 * side of a coupled pair is judged on the pair it produces.
 */
export function validateAgentUpdateRequest(input: unknown): AgentUpdateRequestResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: [{ path: '(root)', message: 'Agent update body must be a JSON object' }] };
  }

  const body = input as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body)) {
    // The precondition is not a definition field and is read separately below.
    if ((PRECONDITION_FIELDS as readonly string[]).includes(key)) continue;
    // The canonical roster gets its own refusal rather than the generic
    // unknown-field message, so this path and the create path answer a roster
    // with the same capability id and the same reason. The /v1/agents write
    // path rewrites every `multiagent` value before this validator runs —
    // `null` becomes a `delegations` clear and a coordinator block becomes a
    // normalized roster — so a value seen here is one no store-backed path
    // pre-processed; the coordinator-specific refusal names that bound and a
    // malformed block reports the coordinator rule.
    if (key === 'multiagent') {
      if (value !== null) {
        const parsed = parseCoordinatorBlock(value);
        if (parsed !== 'not-coordinator') {
          if (!parsed.ok) {
            errors.push(...parsed.errors);
          } else {
            errors.push({
              path: 'multiagent',
              message: 'A coordinator multiagent block is normalized to `delegations` on the /v1/agents write path; this update validator holds no store to resolve ids against.',
            });
          }
          continue;
        }
      }
      errors.push(multiagentRosterRefusal());
      continue;
    }
    const schema = UPDATE_FIELD_SCHEMAS[key];
    if (!schema) {
      errors.push({ path: key, message: `Unknown agent update field "${key}"` });
      continue;
    }
    if (value === null && NON_CLEARABLE_FIELDS[key] !== undefined) {
      errors.push({ path: key, message: NON_CLEARABLE_FIELDS[key] });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? `${key}.${issue.path.join('.')}` : key;
        errors.push({ path, message: issue.message });
      }
      continue;
    }
    fields[key] = parsed.data;
  }

  // Absent means "no precondition". Present-but-malformed is a 400 rather
  // than a silent downgrade to an unconditional update: a client that meant
  // to guard against lost writes must not get an unguarded one from a typo.
  // Both accepted spellings are read here, including the published one.
  const expectedVersion = resolvePrecondition(body, errors);

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, fields, expectedVersion };
}

/**
 * Apply validated update fields to the stored definition and return the
 * merged raw definition for full-schema revalidation.
 */
export function applyAgentUpdatePatch(
  current: AgentDefinition,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };

  // `model_config` is derived from the canonical `model` value, so replacing
  // the model without an explicit config must not leave a stale id or speed
  // pointing at the previous model.
  if ('model' in fields && !('model_config' in fields)) delete next.model_config;

  for (const [key, value] of Object.entries(fields)) {
    if (key === 'metadata') {
      if (value === null) {
        delete next.metadata;
        continue;
      }
      const merged: Record<string, unknown> = { ...(next.metadata as Record<string, unknown> | undefined) };
      for (const [metaKey, metaValue] of Object.entries(value as Record<string, unknown>)) {
        if (metaValue === null) delete merged[metaKey];
        else merged[metaKey] = metaValue;
      }
      next.metadata = merged;
      continue;
    }

    if (value === null) {
      // `system` is a required field on the definition, so clearing it stores
      // the empty string; every other clearable field is simply removed.
      if (key === 'system') next.system = '';
      else delete next[key];
      continue;
    }

    next[key] = value;
  }

  return next;
}

/**
 * Compare two definitions for update-relevant equality.
 *
 * Key order is normalized so a metadata merge that touches no value is a
 * no-op, while array order stays significant because tool and roster order
 * are observable in the API response.
 */
export function agentDefinitionsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
