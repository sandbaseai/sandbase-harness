/**
 * Per-session agent configuration overrides (`agent_with_overrides`).
 *
 * The published contract lets a session run an agent with part of its
 * configuration replaced, without versioning the agent. One tri-state rule
 * governs every overridable field, and it is enforced here rather than at the
 * route so the resolution is one function with one behaviour:
 *
 * - **omitted** → the session inherits the value from the referenced agent
 *   version;
 * - **`null`** (or `[]` for a list) → the session runs with the field cleared;
 * - **a value** → the field is replaced wholesale. Overrides never merge, so a
 *   `tools` override must list every tool the session should have.
 *
 * Three documented exceptions apply, and each is a refusal carrying its own
 * code rather than a silent repair:
 *
 * - `model` can never be cleared (`agent_model_required`);
 * - clearing `tools` while the effective `skills` is non-empty is refused
 *   (`agent_tools_cleared_with_skills`), because skills need the `read` tool;
 * - the resolved definition may not reference an MCP server it does not declare
 *   (`agent_mcp_server_not_found`).
 *
 * A `model` override replaces the whole model object, so the agent's own
 * `effort` is not inherited. An `effort` inside the override is refused rather
 * than accepted and ignored, for the same reason it is retained on a definition:
 * the provider model is resolved from the agent's model id, so a level set on a
 * session has no path into a request. What a provider does see is the
 * deployment's own `reasoning_effort` model setting, which is operator-level and
 * applies to a model rather than to one session. The canonical definition keeps
 * the value the published request shape carries, and it is where the published
 * contract puts the field, so there is nothing to preserve on this path.
 */

import { z } from 'zod';
import type {
  AgentDefinition,
  AgentModelSpeed,
  AgentOverrides,
  AgentSkillRef,
  AgentToolset,
  McpServerConfig,
} from '@/types/agent.js';
import { normalizeModelField } from './model-object.js';
import { agentToolsetSchema, mcpServerConfigSchema, skillRefSchema } from './schema.js';

/** The `agent.type` value that selects this reference form. */
export const AGENT_OVERRIDE_TYPE = 'agent_with_overrides';

/** Fields a session may override. Anything else in the object is refused. */
export const AGENT_OVERRIDE_FIELDS = ['model', 'system', 'tools', 'mcp_servers', 'skills'] as const;

export type AgentOverrideField = (typeof AGENT_OVERRIDE_FIELDS)[number];

/**
 * Stable error codes for every override refusal.
 *
 * A client has to distinguish "this field cannot be cleared" from "this value is
 * malformed" and from "these two overrides conflict", so each condition
 * publishes its own code instead of one generic 400. A malformed `model` reports
 * the model profile's own code (`invalid_model_speed`, `unsupported_model_field`
 * and so on), the same one the agent definition path publishes for that field.
 */
export const AGENT_OVERRIDE_ERROR_CODES = {
  /** `model` was explicitly cleared. */
  modelRequired: 'agent_model_required',
  /** A cleared `tools` would leave skills without the `read` tool they need. */
  toolsClearedWithSkills: 'agent_tools_cleared_with_skills',
  /** The resolved definition references an MCP server it does not declare. */
  unknownMcpServer: 'agent_mcp_server_not_found',
  /** An override field was present but failed validation. */
  invalidField: 'invalid_agent_override_field',
  /** The override object itself is not a well-formed `agent_with_overrides`. */
  invalidOverrides: 'invalid_agent_overrides',
} as const;

export type AgentOverrideErrorCode =
  (typeof AGENT_OVERRIDE_ERROR_CODES)[keyof typeof AGENT_OVERRIDE_ERROR_CODES];

export type ParsedOverrides =
  | { ok: true; overrides: AgentOverrides }
  | { ok: false; code: string; message: string };

export type OverrideResolution =
  | { ok: true; definition: AgentDefinition; changed: AgentOverrideField[] }
  | { ok: false; code: string; message: string };

/**
 * Parse an `agent_with_overrides` payload into a validated override set.
 *
 * `type`, `id` and `version` are the reference; everything else must be an
 * overridable field. An unrecognized key is refused, because a caller that sends
 * one believes it changed how the session runs.
 */
export function parseAgentOverrides(value: Record<string, unknown>): ParsedOverrides {
  const unknown = Object.keys(value).filter(
    (key) => !['type', 'id', 'version', ...AGENT_OVERRIDE_FIELDS].includes(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      code: AGENT_OVERRIDE_ERROR_CODES.invalidOverrides,
      message: `agent does not support field(s): ${unknown.join(', ')}. Overridable fields: ${AGENT_OVERRIDE_FIELDS.join(', ')}.`,
    };
  }

  const overrides: AgentOverrides = {};

  if ('model' in value) {
    if (value.model === null) {
      overrides.model = null;
    } else {
      // The model profile is the same one an agent definition uses, so an
      // unsupported field is refused with the code a caller already knows.
      const profile = normalizeModelField(value.model);
      if (!profile.ok || !profile.value) {
        return {
          ok: false,
          code: profile.code ?? AGENT_OVERRIDE_ERROR_CODES.invalidField,
          message: profile.message ?? 'model is invalid',
        };
      }
      if (profile.value.effort) {
        return fail(
          'model.effort',
          'model.effort cannot be set by an agent override: the provider model is resolved from the agent\'s model id, so a level set here would reach no request. The agent definition is where the field is retained and returned; set it there instead.',
        );
      }
      overrides.model = {
        id: profile.value.id,
        ...(profile.value.speed ? { speed: profile.value.speed } : {}),
      };
    }
  }

  if ('system' in value) {
    if (value.system === null) {
      overrides.system = null;
    } else if (typeof value.system !== 'string') {
      return fail('system', 'system must be a string or null');
    } else {
      overrides.system = value.system;
    }
  }

  if ('tools' in value) {
    if (value.tools === null) {
      overrides.tools = null;
    } else {
      const parsed = readList(value.tools, z.array(agentToolsetSchema), 'tools');
      if (!parsed.ok) return parsed;
      overrides.tools = parsed.value as AgentToolset[];
    }
  }

  if ('mcp_servers' in value) {
    if (value.mcp_servers === null) {
      overrides.mcp_servers = null;
    } else {
      const parsed = readList(value.mcp_servers, z.array(mcpServerConfigSchema), 'mcp_servers');
      if (!parsed.ok) return parsed;
      const names = new Set<string>();
      for (const server of parsed.value as McpServerConfig[]) {
        if (names.has(server.name)) {
          return fail('mcp_servers', `duplicate MCP server name "${server.name}"`);
        }
        names.add(server.name);
      }
      overrides.mcp_servers = parsed.value as McpServerConfig[];
    }
  }

  if ('skills' in value) {
    if (value.skills === null) {
      overrides.skills = null;
    } else {
      const parsed = readList(value.skills, z.array(skillRefSchema), 'skills');
      if (!parsed.ok) return parsed;
      overrides.skills = parsed.value as AgentSkillRef[];
    }
  }

  return { ok: true, overrides };
}

/**
 * Apply an override set to an agent definition, producing the session-local
 * snapshot. The base definition is never mutated, so the durable agent and every
 * other session keep their configuration.
 */
export function applyAgentOverrides(base: AgentDefinition, overrides: AgentOverrides): OverrideResolution {
  const definition: AgentDefinition = { ...base };
  const changed: AgentOverrideField[] = [];

  if (overrides.model !== undefined) {
    if (overrides.model === null) {
      return {
        ok: false,
        code: AGENT_OVERRIDE_ERROR_CODES.modelRequired,
        message: 'agent.model cannot be cleared; a session always requires a model.',
      };
    }
    definition.model = overrides.model.id;
    definition.model_config = {
      id: overrides.model.id,
      speed: (overrides.model.speed ?? 'standard') as AgentModelSpeed,
    };
    changed.push('model');
  }

  if (overrides.system !== undefined) {
    // `null` clears the prompt for this session: the empty string is what a
    // cleared prompt is in a definition, and any assigned skills still append.
    definition.system = overrides.system ?? '';
    changed.push('system');
  }

  // Resolution order is deliberate: `skills` gates clearing `tools`, and the
  // effective `tools` is what the MCP cross-check below reads.
  if (overrides.skills !== undefined) {
    definition.skills = overrides.skills ?? [];
    changed.push('skills');
  }

  if (overrides.tools !== undefined) {
    const cleared = overrides.tools === null || overrides.tools.length === 0;
    if (cleared && (definition.skills ?? []).length > 0) {
      return {
        ok: false,
        code: AGENT_OVERRIDE_ERROR_CODES.toolsClearedWithSkills,
        message: 'agent.tools cannot be cleared while agent.skills is non-empty; skills require the read tool. Override skills in the same request.',
      };
    }
    definition.tools = cleared ? [] : (overrides.tools as AgentToolset[]);
    changed.push('tools');
  }

  if (overrides.mcp_servers !== undefined) {
    definition.mcp_servers = overrides.mcp_servers ?? [];
    changed.push('mcp_servers');
  }

  // The cross-check runs on the resolved definition rather than only when
  // `mcp_servers` was overridden: a `tools` override that introduces an
  // `mcp_toolset` for an undeclared server is the same defect, and it would
  // otherwise persist as a toolset that silently does nothing.
  const declared = new Set((definition.mcp_servers ?? []).map((server) => server.name));
  const orphaned = (definition.tools ?? [])
    .filter((toolset): toolset is Extract<AgentToolset, { type: 'mcp_toolset' }> => toolset.type === 'mcp_toolset')
    .map((toolset) => toolset.mcp_server_name)
    .filter((name) => !declared.has(name));
  if (orphaned.length > 0) {
    return {
      ok: false,
      code: AGENT_OVERRIDE_ERROR_CODES.unknownMcpServer,
      message: `agent.tools references MCP server(s) not declared in agent.mcp_servers: ${orphaned.join(', ')}.`,
    };
  }

  return { ok: true, definition, changed };
}

/** An override refusal, carrying the code the API answers with. */
export function agentOverrideError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export function isAgentOverrideError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return (Object.values(AGENT_OVERRIDE_ERROR_CODES) as string[]).includes(code)
    // Model-profile refusals are override refusals too: they come out of the
    // same parse and are answered with the same 400.
    || code.startsWith('invalid_model')
    || code === 'unsupported_model_field';
}

function readList<T>(
  value: unknown,
  schema: z.ZodType<T>,
  field: string,
): { ok: true; value: T } | { ok: false; code: string; message: string } {
  if (!Array.isArray(value)) return fail(field, `${field} must be an array or null`);
  const parsed = schema.safeParse(value);
  if (!parsed.success) return fail(field, firstIssue(parsed.error, field));
  return { ok: true, value: parsed.data };
}

function fail(field: string, message: string): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: AGENT_OVERRIDE_ERROR_CODES.invalidField,
    message: `agent.${field}: ${message}`,
  };
}

function firstIssue(error: z.ZodError, field: string): string {
  const issue = error.issues[0];
  if (!issue) return `${field} is invalid`;
  const path = issue.path.join('.');
  return path ? `${field}.${path}: ${issue.message}` : `${field}: ${issue.message}`;
}
