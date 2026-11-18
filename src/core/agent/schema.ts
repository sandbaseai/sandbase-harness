/**
 * Agent Definition Schema Validator
 *
 * Uses Zod to validate AgentDefinition objects loaded from YAML/JSON.
 * Returns structured errors with field path and reason on failure.
 */

import { z } from 'zod';
import { BUILTIN_TOOL_NAMES } from '@/core/capabilities/registry.js';
import { modelCapabilityRejection, normalizeModelField, type ModelEffortLevel } from '@/core/agent/model-object.js';
import { anthropicModelCapabilities } from '@/model/anthropic-capabilities.js';
import {
  validateWebToolConfigs,
  webToolPolicyFieldsSchema,
} from '@/core/agent/web-tool-policy.js';
import type { AgentDefinition, AgentModelConfig, AgentModelSpeed, AgentToolset } from '@/types/agent.js';

// ============================================================
// MCP Server Config Schema
// ============================================================

export const mcpServerConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('url'),
    // The published bound is a 1–255 character server name, unique within the
    // agent. Both entries name the same field, so one bounded schema serves
    // the url and stdio arms alike.
    name: z.string().min(1, 'MCP server name is required').max(255, 'MCP server name must be at most 255 characters'),
    // The published endpoint bound is 2,048 characters; an over-long url is a
    // shape error, not a connectivity failure.
    url: z.string().url().max(2048, 'MCP server url must be at most 2048 characters'),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('stdio'),
    name: z.string().min(1, 'MCP server name is required').max(255, 'MCP server name must be at most 255 characters'),
    command: z.string().min(1, 'stdio MCP server command is required'),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeout: z.number().positive().optional(),
  }),
]);

const permissionPolicySchema = z.object({
  type: z.enum(['always_allow', 'always_ask', 'never_allow', 'auto']),
});

const agentToolConfigSchema = z.object({
  enabled: z.boolean().optional(),
  permission_policy: permissionPolicySchema.optional(),
});

const builtinToolConfigSchema = agentToolConfigSchema.extend({
  name: z.enum(BUILTIN_TOOL_NAMES),
  // Web-tool domain lists are typed here so they survive parsing, but the
  // grammar itself is enforced structurally in web-tool-policy.ts: a Zod
  // string[] would emit a generic message that loses the list and index the
  // published contract makes normative.
  ...webToolPolicyFieldsSchema,
});

const mcpToolConfigSchema = agentToolConfigSchema.extend({
  name: z.string().min(1, 'Tool config name is required').max(128),
});

const jsonSchemaValue = z.record(z.string(), z.unknown());

/**
 * The published custom-tool name grammar: letters, digits, underscores, and
 * hyphens, 1–128 characters — the character set an MCP server emits, not a
 * narrower identifier. Leading digits and underscores are legal; the reserved
 * `mcp__`/`ant__` prefixes and the built-in tool names are refused separately
 * in `validateCustomToolDefinitions`, because a schema-level message cannot
 * name which rule the name broke.
 */
const customToolNameSchema = z.string()
  .min(1, 'Custom tool name is required')
  .max(128, 'Custom tool name must be at most 128 characters')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Custom tool name must contain only letters, numbers, underscores, or hyphens');

const customToolConfigSchema = agentToolConfigSchema.extend({
  name: customToolNameSchema,
  description: z.string().min(1, 'Custom tool description is required').max(4096),
  // `input_schema` is accepted for CMA-shaped definitions; normalization below
  // gives the runtime one canonical `parameters` field.
  input_schema: jsonSchemaValue.optional(),
  parameters: jsonSchemaValue.optional(),
}).refine(
  (config) => config.input_schema !== undefined || config.parameters !== undefined,
  { path: ['parameters'], message: 'Custom tool requires input_schema or parameters' },
);

/**
 * Canonical CMA custom tool: an independent `tools[]` entry.
 *
 * Deliberately has no `permission_policy` and no `enabled` field. The caller
 * executes the tool and decides whether to run it, so accepting a policy here
 * would claim governance the runtime does not hold. `parameters` stays accepted
 * as a legacy alias so a SandBase-authored definition keeps validating; the
 * canonical field is `input_schema`.
 */
const canonicalCustomToolSchema = z.object({
  type: z.literal('custom'),
  name: customToolNameSchema,
  description: z.string().min(1, 'Custom tool description is required').max(4096),
  input_schema: jsonSchemaValue,
  parameters: jsonSchemaValue.optional(),
}).strict();

export const agentToolsetSchema = z.union([
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('agent_toolset_20260401'),
      configs: z.array(builtinToolConfigSchema).default([]),
      default_config: agentToolConfigSchema.optional(),
    }),
    z.object({
      type: z.literal('mcp_toolset'),
      mcp_server_name: z.string().min(1, 'MCP toolset server name is required'),
      configs: z.array(mcpToolConfigSchema).default([]),
      default_config: agentToolConfigSchema.optional(),
    }),
    z.object({
      type: z.literal('custom_toolset'),
      configs: z.array(customToolConfigSchema).min(1, 'Custom toolset must declare at least one tool'),
      default_config: agentToolConfigSchema.optional(),
    }),
  ]),
  canonicalCustomToolSchema,
]);

export const skillRefSchema = z.object({
  type: z.enum(['custom', 'anthropic']),
  skill_id: z.string().min(1, 'Skill id is required'),
  version: z.string().optional(),
});

const modelSpeedSchema = z.enum(['fast', 'standard', 'extended']);

/**
 * Reasoning effort accepted by the published contract.
 *
 * Parsed and validated so an unsupported level fails loudly, then carried
 * through so the value survives a read-back instead of being dropped on the
 * way in. Anthropic execution is gated by the selected model's capabilities.
 */
export const modelEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const agentModelConfigSchema = z.object({
  id: z.string().min(1, 'Model id is required').optional(),
  speed: modelSpeedSchema.default('standard'),
  // The local `model_config` spelling is also a request shape, and the read
  // projection returns `effort` inside it. Accepting it here is what keeps a
  // value the caller can read back from being silently dropped when they send it
  // again. A level outside the published set is refused as a shape error at
  // `model_config.effort`, which names the field: the canonical `model.effort`
  // path cannot, because there the object and the bare string are one union and
  // the issue is reported at `model`.
  effort: modelEffortSchema.optional(),
});

/**
 * Canonical `model` object.
 *
 * `inference_geo` is deliberately absent: the parser in `model-object.ts`
 * rejects a well-formed pin with `unsupported_model_field` rather than
 * silently accepting a data-residency claim this runtime cannot honour. A
 * schema here would have to either admit the field (and lie) or produce a
 * generic validation error that does not name the problem.
 */
export const agentModelObjectSchema = z.object({
  id: z.string().min(1, 'Model id is required'),
  speed: modelSpeedSchema.optional(),
  effort: z.union([modelEffortSchema, z.object({ type: modelEffortSchema })])
    .transform((effort) => typeof effort === 'string' ? effort : effort.type)
    .optional(),
});

// The canonical object form is tried before the bare string so a definition
// that carries `effort` is parsed by the schema that knows the field. Reversing
// the order would let the string arm never see it and the legacy object arm
// strip it, which is exactly the silent loss this parser exists to prevent.
export const agentModelInputSchema = z.union([
  agentModelObjectSchema,
  z.string().min(1, 'Model id is required'),
]);

// ============================================================
// Agent Definition Schema
// ============================================================

/**
 * The agent name rule.
 *
 * Extracted so a partial update validates a name against the same shape the
 * create path uses, rather than re-declaring the pattern and letting the two
 * drift.
 */
export const agentNameSchema = z
  .string()
  .min(1, 'Agent name is required')
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Agent name must be alphanumeric with spaces, hyphens, or underscores');

export const agentDefinitionSchema = z.object({
  name: agentNameSchema,
  model: agentModelInputSchema,
  model_config: agentModelConfigSchema.optional(),
  system: z.string().nullish().transform((system) => system ?? ''),
  description: z.string().optional(),
  // The published session bound is 500 skills, counted as the deduplicated set
  // across every agent in the session. This runtime runs one agent per
  // session, so the agent's own skills array is the whole set and the bound
  // lands here.
  skills: z.array(skillRefSchema).max(500, 'The skills array accepts at most 500 skills').optional(),
  // The published bound is 20 declared servers per agent; an over-large
  // roster is refused rather than partially connected.
  mcp_servers: z.array(mcpServerConfigSchema).max(20, 'The mcp_servers array accepts at most 20 servers').optional(),
  // The published bound is 256 entries: each wrapped tool is one entry and the
  // built-in toolset is one more, so an over-large array is refused rather than
  // truncated into a surface the model could not navigate.
  tools: z.array(agentToolsetSchema).max(256, 'The tools array accepts at most 256 entries').optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  max_turns: z.number().int().positive().max(1000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  delegations: z.array(z.string()).optional(),
  /**
   * Internal provenance marker, written only by the coordinator normalizer on
   * the API write path. Declared here so a stored definition keeps it through
   * re-validation (the schema strips undeclared keys); callers writing it
   * directly only narrow their own delegation depth.
   */
  delegations_source: z.literal('coordinator').optional(),
  enable_general_subagent: z.boolean().optional(),
  strategy: z.string().optional(),
  environment: z.string().optional(),
});

// ============================================================
// Validation Result Types
// ============================================================

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  data?: AgentDefinition;
  errors?: ValidationError[];
}

// ============================================================
// Validation Function
// ============================================================

/**
 * Capability id the canonical `multiagent` roster refusal points at.
 *
 * Exported so the create path, the update path, and the capability matrix name
 * the same capability: a refusal a caller cannot look up is a refusal they
 * cannot act on.
 */
export const MULTIAGENT_ROSTER_CAPABILITY_ID = 'multiagent-roster';

/**
 * Capability id the coordinator acceptance points at.
 *
 * Coordinator is the delegation-only subset upstream self-hosted accepts; the
 * roster admission lives under the threads capability because the delivery
 * surface it belongs to is the thread family. Kept separate from
 * `MULTIAGENT_ROSTER_CAPABILITY_ID` so a caller refused the full roster and a
 * caller whose coordinator block almost parsed can be told which rule broke.
 */
export const THREADS_COORDINATOR_CAPABILITY_ID = 'threads-and-coordinator';

/**
 * The refusal for a canonical `multiagent` roster.
 *
 * Returned rather than letting the schema strip the field. `agentDefinitionSchema`
 * drops what it does not declare, so without this check a create request carrying
 * a roster would answer 201 and behave as if the roster did not exist — the
 * caller would believe delegation by roster was in effect. The runtime implements
 * no thread, workflow, or advisor surface, so the only honest answer is a named
 * refusal that points at the capability and at the local delegation extension.
 *
 * Coordinator is the one block shape this does not cover: a `type:"coordinator"`
 * block is the delegation-only subset upstream self-hosted accepts, and it is
 * normalized to `delegations` before this refusal could see it.
 */
export function multiagentRosterRefusal(): ValidationError {
  return {
    path: 'multiagent',
    message:
      `The canonical multiagent roster is not implemented yet (capability "${MULTIAGENT_ROSTER_CAPABILITY_ID}", decision decisions/0002): no thread, workflow, or advisor surface is implemented, so every \`type\` other than "coordinator" is refused rather than accepted and ignored. `
      + 'The delegation-only coordinator subset is accepted and normalized to `delegations`; "enable_general_subagent" allows a one-level temporary sub-agent. '
      + 'GET /v1/x/capabilities records the gap.',
  };
}

/** True when the caller's own payload carries a `multiagent` key. */
export function declaresMultiagentRoster(input: unknown): boolean {
  return (
    !!input
    && typeof input === 'object'
    && !Array.isArray(input)
    && Object.prototype.hasOwnProperty.call(input, 'multiagent')
  );
}

// ============================================================
// Coordinator multiagent block
// ============================================================

/**
 * The `agents` entry forms upstream accepts inside a coordinator block: a bare
 * `agent_…` id string, `{"type":"agent","id":"agent_…"}`, the same with a
 * `version` pin, and `{"type":"self"}` for a copy of the agent itself. The
 * published forms are verified against
 * `official-docs/multiagent-orchestration.md` ("Predefined and inline
 * agents"); anything else — an inline agent definition, a workflow block, an
 * advisor — is refused by the coordinator rule, not the generic roster one,
 * so the caller learns which bound they broke.
 */
const coordinatorAgentEntrySchema = z.union([
  z.string().regex(/^agent_[A-Za-z0-9_-]+$/, 'agents[] entries must name an agent id (agent_…) or use {type:"agent",id}/{type:"self"}'),
  z.object({
    type: z.literal('agent'),
    id: z.string().regex(/^agent_[A-Za-z0-9_-]+$/, 'agents[].id must be an agent id (agent_…)'),
    // Accepted and documented as resolved-to-latest rather than pinned: the
    // archived-version lookup is a separate feature, and storing the pin would
    // promise a resolution the roster does not perform.
    version: z.number().int().positive().optional(),
  }).strict(),
  z.object({ type: z.literal('self') }).strict(),
]);

/**
 * The one `multiagent` block shape this runtime accepts: upstream self-hosted's
 * delegation-only coordinator subset. `agents` is the top-level list of 1–20
 * predefined-agent entries — upstream: "List 1 to 20 agents in `agents`"
 * (`official-docs/self-hosted/differences.md`).
 *
 * Strict so a coordinator block carrying `advisor`, `workflows`, `subagents`,
 * `inline_agents`, or any other key is a coordinator-rule refusal rather than
 * an unknown-key strip: the caller sent the accepted type and broke a named
 * bound, and the refusal must say so.
 */
export const coordinatorMultiagentSchema = z.object({
  type: z.literal('coordinator'),
  agents: z.array(coordinatorAgentEntrySchema)
    .min(1, 'coordinator agents must list 1 to 20 entries')
    .max(20, 'coordinator agents must list 1 to 20 entries'),
}).strict();

export interface ParsedCoordinatorAgentRef {
  /** `agent_…` id, or `null` for a `{type:"self"}` entry. */
  id: string | null;
  /** Present when the caller pinned a version; resolved to latest, by decision. */
  version?: number;
}

export type CoordinatorNormalization =
  | { ok: true; refs: ParsedCoordinatorAgentRef[]; selfIncluded: boolean }
  | { ok: false; errors: ValidationError[] };

/**
 * Parse a `multiagent` block the caller sent. Three outcomes:
 *
 * - not an object / not a `coordinator` block → the generic roster refusal
 *   (every other `type` stays refused, `multiagent_20261001` included);
 * - a `coordinator` block that breaks the published bounds → a refusal that
 *   names the coordinator rule, so a caller who sent the accepted type learns
 *   which bound they hit (advisor key, 21 entries, an inline form, a missing
 *   `agents`, …);
 * - a well-formed block → the parsed refs for id→name resolution. `agents`
 *   entries are not resolved here because this layer does not hold the store.
 */
export function parseCoordinatorBlock(input: unknown): CoordinatorNormalization | 'not-coordinator' {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'not-coordinator';
  const record = input as Record<string, unknown>;
  if (record.type !== 'coordinator') return 'not-coordinator';

  const result = coordinatorMultiagentSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => ({
        path: ['multiagent', ...issue.path].join('.'),
        message: `coordinator multiagent: ${issue.message}`,
      })),
    };
  }

  const refs: ParsedCoordinatorAgentRef[] = [];
  let selfIncluded = false;
  for (const entry of result.data.agents) {
    if (typeof entry === 'string') {
      refs.push({ id: entry });
      continue;
    }
    if (entry.type === 'self') {
      selfIncluded = true;
      continue;
    }
    refs.push({ id: entry.id, ...(entry.version !== undefined ? { version: entry.version } : {}) });
  }
  return { ok: true, refs, selfIncluded };
}

/**
 * Validate an unknown object against the AgentDefinition schema.
 * Returns structured errors with field paths on failure.
 */
export function validateAgentDefinition(input: unknown): ValidationResult {
  const result = agentDefinitionSchema.safeParse(input);

  if (!result.success) {
    const errors: ValidationError[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    }));

    return { valid: false, errors };
  }

  // Refused from the caller's own value, before the schema's stripped copy is
  // trusted, so the field cannot be dropped on the way to the store.
  if (declaresMultiagentRoster(input)) {
    const block = (input as Record<string, unknown>).multiagent;
    const parsed = parseCoordinatorBlock(block);
    if (parsed !== 'not-coordinator') {
      // A coordinator block is accepted on the /v1/agents write path, where it
      // is normalized to `delegations` by resolving each id against the store.
      // This layer holds no store, so a definition file or a merged update that
      // still carries the raw block cannot be resolved here; the refusal names
      // the path that can. A malformed block reports the coordinator rule first
      // so the caller learns which bound they broke.
      if (!parsed.ok) return { valid: false, errors: parsed.errors };
      return {
        valid: false,
        errors: [{
          path: 'multiagent',
          message:
            'A coordinator multiagent block is accepted on the /v1/agents write paths, where its agent ids resolve to names; this path cannot resolve ids, so write it through the API or use the local "delegations" name list.',
        }],
      };
    }
    return { valid: false, errors: [multiagentRosterRefusal()] };
  }

  // Domain-list rules the schema cannot express without losing the exact
  // list and index the published contract requires in the message.
  const webToolErrors = validateWebToolConfigs(result.data.tools);
  if (webToolErrors.length > 0) {
    return { valid: false, errors: webToolErrors };
  }

  const referenceErrors = validateMcpServerReferences(result.data);
  if (referenceErrors.length > 0) {
    return { valid: false, errors: referenceErrors };
  }

  const customToolErrors = validateCustomToolDefinitions(result.data);
  if (customToolErrors.length > 0) {
    return { valid: false, errors: customToolErrors };
  }

  // A field the runtime cannot honour is refused by name rather than accepted
  // and quietly dropped. The schema strips what it does not know, so this runs
  // against the caller's own value; a shape error has already been reported
  // above and is left untouched.
  const modelProfile = normalizeModelField(
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).model
      : undefined,
  );
  if (!modelProfile.ok) {
    return {
      valid: false,
      errors: [{
        path: modelProfile.field && modelProfile.field !== 'model'
          ? `model.${modelProfile.field}`
          : 'model',
        message: modelProfile.message ?? 'model is invalid',
      }],
    };
  }

  // The `model_config` spelling bypasses `normalizeModelField` — the object
  // `model` form carries its own profile — so its capability check runs here
  // against the effective id. When the object `model` form is authoritative
  // `model_config` is ignored entirely and needs no second look.
  if (typeof result.data.model === 'string' && result.data.model_config) {
    const configRejection = modelCapabilityRejection({
      id: result.data.model_config.id ?? result.data.model,
      speed: result.data.model_config.speed,
      effort: result.data.model_config.effort,
    });
    if (configRejection) {
      return {
        valid: false,
        errors: [{
          path: configRejection.field ? `model_config.${configRejection.field}` : 'model_config',
          message: configRejection.message ?? 'model_config is invalid',
        }],
      };
    }
  }

  return { valid: true, data: normalizeAgentDefinition(result.data) };
}

/**
 * The stored model profile, derived from whichever `model` form the caller sent.
 *
 * `effort` lives *inside* the profile, beside the id and speed it belongs to.
 * An earlier version wrote it as a sibling of `model_config`, where nothing read
 * it: the value survived in the row but no read-back could reach it. Definitions
 * written then are still readable — `readAgentDefinitionFromRow` folds the sibling
 * into the profile before validating, and `toApiAgent` honours that spelling as
 * well — and an update through either path rewrites it in place. When `model` is
 * the object form it is authoritative: the profile is derived from that object,
 * and a `model_config` sent beside it is ignored rather than merged.
 */
/**
 * The level the published service resolves when a definition omits `effort`.
 *
 * Backed by the published effort page: `medium` on Claude Opus 5.5 and Claude
 * Haiku 5.5, `high` on every other model that accepts effort, and `undefined`
 * on a model with no effort support or one the capability table does not know.
 * An `undefined` return means "do not invent a level" — the stored profile
 * keeps `effort` absent rather than writing a guess, which is the honest
 * answer for a model this runtime cannot name a default for.
 */
function modelEffortDefault(modelId: string): ModelEffortLevel | undefined {
  return anthropicModelCapabilities(modelId)?.effortDefault;
}

function normalizeModelConfig(profile: {
  id: string;
  speed: AgentModelSpeed;
  effort?: string;
}): AgentModelConfig {
  return {
    id: profile.id,
    speed: profile.speed,
    // Parsed and validated before this point so an unsupported level fails
    // loudly, then carried through so the value survives a read-back — and, on
    // Anthropic provider models that support the level, reaches the request.
    // An omitted level falls back to the model's documented save-time default
    // so the stored definition is self-describing rather than inheriting
    // whatever the runtime/provider happens to fall back to. An explicit value
    // always wins; a model the capability table does not cover keeps the field
    // absent rather than guessing a default.
    ...(profile.effort
      ? { effort: profile.effort }
      : modelEffortDefault(profile.id) ? { effort: modelEffortDefault(profile.id) } : {}),
  };
}

function normalizeAgentDefinition(data: z.infer<typeof agentDefinitionSchema>): AgentDefinition {
  const normalizedTools = normalizeCustomToolsets(data.tools);

  if (typeof data.model === 'string') {
    const modelId = data.model_config?.id ?? data.model;
    return {
      ...data,
      model: data.model,
      ...(normalizedTools ? { tools: normalizedTools } : {}),
      // A bare `model` string with no `model_config` still resolves the
      // save-time effort default so the stored definition is self-describing.
      model_config: normalizeModelConfig({
        id: modelId,
        speed: data.model_config?.speed ?? 'standard',
        effort: data.model_config?.effort,
      }),
    } as AgentDefinition;
  }

  return {
    ...data,
    model: data.model.id,
    ...(normalizedTools ? { tools: normalizedTools } : {}),
    model_config: normalizeModelConfig({
      id: data.model.id,
      speed: data.model.speed ?? 'standard',
      ...(data.model.effort ? { effort: data.model.effort } : {}),
    }),
  } as AgentDefinition;
}
/**
 * Cross-check the MCP server list against the MCP toolsets that bind it.
 *
 * An MCP toolset grants the tools a declared server provides, so the two lists
 * are one contract. A toolset naming an undeclared server has no transport to
 * connect to, and a declared server with no toolset is invisible to the agent;
 * both persist successfully and then silently do nothing at execution time. A
 * duplicate server name is refused because a toolset reference would then be
 * ambiguous.
 *
 * Two toolsets may bind the same declared server: that is a legitimate fan-out
 * of one transport across two tool groups, not a duplicate.
 */
function validateMcpServerReferences(
  data: z.infer<typeof agentDefinitionSchema>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const servers = data.mcp_servers ?? [];

  const declaredNames = new Set<string>();
  servers.forEach((server, index) => {
    if (declaredNames.has(server.name)) {
      errors.push({
        path: `mcp_servers.${index}.name`,
        message: `Duplicate MCP server name "${server.name}"; toolset references would be ambiguous`,
      });
      return;
    }
    declaredNames.add(server.name);
  });

  const boundNames = new Set<string>();
  (data.tools ?? []).forEach((toolset, index) => {
    if (toolset.type !== 'mcp_toolset') return;
    if (!declaredNames.has(toolset.mcp_server_name)) {
      errors.push({
        path: `tools.${index}.mcp_server_name`,
        message: `MCP toolset references undeclared MCP server "${toolset.mcp_server_name}"; declare it in mcp_servers`,
      });
      return;
    }
    boundNames.add(toolset.mcp_server_name);
  });

  servers.forEach((server, index) => {
    if (boundNames.has(server.name)) return;
    errors.push({
      path: `mcp_servers.${index}.name`,
      message: `MCP server "${server.name}" has no mcp_toolset, so the agent cannot call it; add a matching toolset or remove the server`,
    });
  });

  return errors;
}

/**
 * Cross-check custom tool declarations across both wire shapes.
 *
 * A custom tool is caller-executed, so the runtime adds no governance of its
 * own: a name that shadows a built-in tool would silently intercept a call the
 * model meant for the built-in, and a name declared twice would make the
 * caller's result ambiguous. Both are refused here rather than at execution
 * time, where the failure would surface as a tool that does nothing.
 */
function validateCustomToolDefinitions(data: z.infer<typeof agentDefinitionSchema>): ValidationError[] {
  const errors: ValidationError[] = [];
  const names = new Set<string>();
  const builtinNames = new Set<string>(BUILTIN_TOOL_NAMES);

  /** One entry per custom tool, regardless of which wire shape declared it. */
  const declared: Array<{ path: string; name: string; schema: Record<string, unknown>; schemaPath: string }> = [];

  (data.tools ?? []).forEach((toolset, toolsetIndex) => {
    if (toolset.type === 'custom') {
      declared.push({
        path: `tools.${toolsetIndex}.name`,
        name: toolset.name,
        schema: toolset.input_schema,
        schemaPath: `tools.${toolsetIndex}.input_schema`,
      });
      return;
    }
    if (toolset.type !== 'custom_toolset') return;
    for (const [configIndex, config] of toolset.configs.entries()) {
      const usesParameters = config.parameters !== undefined;
      declared.push({
        path: `tools.${toolsetIndex}.configs.${configIndex}.name`,
        name: config.name,
        schema: (config.parameters ?? config.input_schema)!,
        schemaPath: `tools.${toolsetIndex}.configs.${configIndex}.${usesParameters ? 'parameters' : 'input_schema'}`,
      });
    }
  });

  for (const tool of declared) {
    // The reserved prefixes and the built-in names are refused by name so the
    // caller knows which rule broke: a name that shadows a built-in intercepts
    // a call meant for the built-in, and the `mcp__`/`ant__` namespaces belong
    // to server-emitted and Anthropic-reserved tools.
    if (tool.name.startsWith('mcp__') || tool.name.startsWith('ant__')) {
      errors.push({
        path: tool.path,
        message: `Custom tool name "${tool.name}" uses a reserved prefix (mcp__ or ant__)`,
      });
    }
    if (builtinNames.has(tool.name)) {
      errors.push({
        path: tool.path,
        message: `Custom tool name "${tool.name}" conflicts with a built-in tool`,
      });
    }
    if (names.has(tool.name)) {
      errors.push({
        path: tool.path,
        message: `Duplicate custom tool name "${tool.name}"`,
      });
    }
    names.add(tool.name);

    const schemaError = validateJsonSchema(tool.schema) ?? validatePublishedInputSchema(tool.schema);
    if (schemaError) errors.push({ path: tool.schemaPath, message: schemaError });
  }

  return errors;
}

/** A `properties` key the published contract accepts: letters, digits,
 * underscores, dots, hyphens, 1–64 characters. */
const TOOL_PROPERTY_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * The published `input_schema` rules layered on the local shape check: a `$ref`
 * is rejected anywhere in the tree because the runtime does not resolve schema
 * references, and a top-level `oneOf`/`anyOf`/`allOf` combinator is rejected
 * because the model-facing surface admits a plain object schema. Property names
 * are bounded to the published character set.
 */
function validatePublishedInputSchema(value: Record<string, unknown>): string | undefined {
  if ('oneOf' in value || 'anyOf' in value || 'allOf' in value) {
    return 'Tool input schema must not use top-level oneOf, anyOf, or allOf';
  }
  if (schemaContainsRef(value)) {
    return 'Tool input schema must not contain $ref';
  }
  if (value.type === 'object' && value.properties && typeof value.properties === 'object' && !Array.isArray(value.properties)) {
    for (const key of Object.keys(value.properties)) {
      if (!TOOL_PROPERTY_NAME.test(key)) {
        return `Tool input schema property name "${key}" must be 1–64 letters, digits, underscores, dots, or hyphens`;
      }
    }
  }
  return undefined;
}

/** Depth-first scan for a `$ref` key anywhere in the schema tree. */
function schemaContainsRef(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(schemaContainsRef);
  const record = node as Record<string, unknown>;
  if ('$ref' in record) return true;
  return Object.values(record).some(schemaContainsRef);
}

function validateJsonSchema(value: Record<string, unknown> | undefined): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Tool input schema must be an object';
  if (value.type !== undefined && (typeof value.type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(value.type))) {
    return 'Tool input schema has an invalid type';
  }
  if (value.type === 'object' && value.properties !== undefined
    && (!value.properties || typeof value.properties !== 'object' || Array.isArray(value.properties))) {
    return 'Object tool input schema properties must be an object';
  }
  if (value.required !== undefined
    && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== 'string'))) {
    return 'Tool input schema required must be an array of strings';
  }
  if (value.type === 'array' && value.items !== undefined
    && (!value.items || typeof value.items !== 'object' || Array.isArray(value.items))) {
    return 'Array tool input schema items must be an object';
  }
  return undefined;
}

/**
 * Normalize both custom tool wire shapes to the canonical `custom` entry.
 *
 * Legacy groupings are accepted on ingress, but every persisted definition is
 * stored in one shape so downstream code never branches on the wire form.
 * `enabled: false` still removes a tool rather than translating to a policy:
 * custom tools are not governed by permission policy, so "disabled" must mean
 * "not declared".
 */
function normalizeCustomToolsets(
  toolsets: z.infer<typeof agentToolsetSchema>[] | undefined,
): AgentToolset[] | undefined {
  if (!toolsets) return undefined;

  const normalized: AgentToolset[] = [];
  for (const toolset of toolsets) {
    if (toolset.type === 'custom') {
      normalized.push({
        type: 'custom',
        name: toolset.name,
        description: toolset.description,
        input_schema: toolset.input_schema,
      } satisfies AgentToolset);
      continue;
    }
    if (toolset.type !== 'custom_toolset') {
      normalized.push(toolset as AgentToolset);
      continue;
    }
    const defaultEnabled = toolset.default_config?.enabled !== false;
    for (const config of toolset.configs) {
      if ((config.enabled ?? defaultEnabled) === false) continue;
      if (config.permission_policy?.type === 'never_allow') continue;
      normalized.push({
        type: 'custom',
        name: config.name,
        description: config.description,
        input_schema: config.parameters ?? config.input_schema!,
      } satisfies AgentToolset);
    }
  }
  return normalized;
}
