/**
 * Agent Definition Schema Validator
 *
 * Uses Zod to validate AgentDefinition objects loaded from YAML/JSON.
 * Returns structured errors with field path and reason on failure.
 */

import { z } from 'zod';
import { BUILTIN_TOOL_NAMES } from '@/core/capabilities/registry.js';
import { modelCapabilityRejection, normalizeModelField } from '@/core/agent/model-object.js';
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
    name: z.string().min(1, 'MCP server name is required'),
    url: z.string().url(),
    timeout: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('stdio'),
    name: z.string().min(1, 'MCP server name is required'),
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
const customToolNameSchema = z.string()
  .min(1, 'Custom tool name is required')
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Custom tool name must start with a letter and contain only letters, numbers, underscores, or hyphens');

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
 * way in. Nothing yet varies model behaviour by it.
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
  effort: modelEffortSchema.optional(),
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
  skills: z.array(skillRefSchema).optional(),
  mcp_servers: z.array(mcpServerConfigSchema).optional(),
  tools: z.array(agentToolsetSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  max_turns: z.number().int().positive().max(1000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  delegations: z.array(z.string()).optional(),
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
 * The refusal for a canonical `multiagent` roster.
 *
 * Returned rather than letting the schema strip the field. `agentDefinitionSchema`
 * drops what it does not declare, so without this check a create request carrying
 * a roster would answer 201 and behave as if the roster did not exist — the
 * caller would believe delegation by roster was in effect. The runtime implements
 * no thread, coordinator, or advisor surface, so the only honest answer is a named
 * refusal that points at the capability and at the local delegation extension.
 */
export function multiagentRosterRefusal(): ValidationError {
  return {
    path: 'multiagent',
    message:
      `The canonical multiagent roster is unavailable in this runtime (capability "${MULTIAGENT_ROSTER_CAPABILITY_ID}"): no thread, coordinator, or advisor surface is implemented, so the roster is refused rather than accepted and ignored. `
      + 'Use the local delegation extension instead — "delegations" names agents to call, and "enable_general_subagent" allows a one-level temporary sub-agent. '
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
    ...(profile.effort ? { effort: profile.effort } : {}),
  };
}

function normalizeAgentDefinition(data: z.infer<typeof agentDefinitionSchema>): AgentDefinition {
  const normalizedTools = normalizeCustomToolsets(data.tools);

  if (typeof data.model === 'string') {
    return {
      ...data,
      model: data.model,
      ...(normalizedTools ? { tools: normalizedTools } : {}),
      ...(data.model_config
        ? {
            model_config: normalizeModelConfig({
              id: data.model_config.id ?? data.model,
              speed: data.model_config.speed,
              ...(data.model_config.effort ? { effort: data.model_config.effort } : {}),
            }),
          }
        : {}),
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

    const schemaError = validateJsonSchema(tool.schema);
    if (schemaError) errors.push({ path: tool.schemaPath, message: schemaError });
  }

  return errors;
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
