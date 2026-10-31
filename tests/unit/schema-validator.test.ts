/**
 * Unit tests for Agent definition schema validation.
 * Validates: Property 1 — Agent definition schema validation completeness.
 */

import { describe, it, expect } from 'vitest';
import { validateAgentDefinition } from '@/core/agent/schema.js';

describe('Agent Definition Schema Validation', () => {
  const validMinimal = {
    name: 'test-agent',
    model: 'gpt-4o',
    system: 'You are a helpful assistant.',
  };

  describe('valid definitions', () => {
    it('accepts minimal valid definition', () => {
      const result = validateAgentDefinition(validMinimal);
      expect(result.valid).toBe(true);
      expect(result.data).toMatchObject(validMinimal);
    });

    it('accepts full definition with all optional fields', () => {
      const full = {
        ...validMinimal,
        description: 'A test agent',
        skills: [
          { type: 'custom', skill_id: 'code-review' },
          { type: 'custom', skill_id: 'web-search', version: '1.0.0' },
        ],
        mcp_servers: [
          { type: 'stdio', name: 'filesystem', command: 'npx', args: ['-y', 'server'] },
          { type: 'url', name: 'github', url: 'http://localhost:3001/mcp' },
        ],
        tools: [
          {
            type: 'agent_toolset_20260401',
            default_config: {
              enabled: true,
              permission_policy: { type: 'always_allow' },
            },
            configs: [
              { name: 'bash', enabled: true },
              { name: 'read', enabled: true },
            ],
          },
          // Each declared MCP server is bound by a toolset, which is what the
          // server/toolset cross-check requires.
          { type: 'mcp_toolset', mcp_server_name: 'filesystem', configs: [] },
          { type: 'mcp_toolset', mcp_server_name: 'github', configs: [] },
        ],
        max_turns: 50,
        temperature: 0.7,
        delegations: ['research-analyst'],
        enable_general_subagent: true,
        strategy: 'default',
        environment: 'dev',
      };
      const result = validateAgentDefinition(full);
      expect(result.valid).toBe(true);
    });

    it('accepts agent names with hyphens and underscores', () => {
      const result = validateAgentDefinition({ ...validMinimal, name: 'my_agent-v2' });
      expect(result.valid).toBe(true);
    });

    it('accepts Claude-style model config objects', () => {
      const result = validateAgentDefinition({
        ...validMinimal,
        model: { id: 'gpt-4o', speed: 'standard' },
      });
      expect(result.valid).toBe(true);
      expect(result.data?.model).toBe('gpt-4o');
      expect(result.data?.model_config).toEqual({ id: 'gpt-4o', speed: 'standard' });
    });
  });

  describe('invalid definitions', () => {
    it('rejects missing name', () => {
      const result = validateAgentDefinition({ model: 'gpt-4o', system: 'hi' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: 'name' }));
    });

    it('rejects missing model', () => {
      const result = validateAgentDefinition({ name: 'test', system: 'hi' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: 'model' }));
    });

    it.each([undefined, null, ''])('normalizes an absent system prompt (%s) to an empty string', (system) => {
      const result = validateAgentDefinition({ name: 'test', model: 'gpt-4o', system });
      expect(result.valid).toBe(true);
      expect(result.data?.system).toBe('');
    });

    it.each([42, {}, []])('rejects a non-string system prompt (%s)', (system) => {
      const result = validateAgentDefinition({ name: 'test', model: 'gpt-4o', system });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: 'system' }));
    });

    it('rejects empty model ids', () => {
      const result = validateAgentDefinition({ ...validMinimal, model: '' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: 'model' }));
    });

    it('rejects empty name', () => {
      const result = validateAgentDefinition({ ...validMinimal, name: '' });
      expect(result.valid).toBe(false);
    });

    it('rejects invalid name characters', () => {
      const result = validateAgentDefinition({ ...validMinimal, name: 'my agent!' });
      expect(result.valid).toBe(false);
    });

    it('rejects invalid temperature (> 2)', () => {
      const result = validateAgentDefinition({ ...validMinimal, temperature: 3.0 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ path: 'temperature' }));
    });

    it('rejects invalid max_turns (negative)', () => {
      const result = validateAgentDefinition({ ...validMinimal, max_turns: -1 });
      expect(result.valid).toBe(false);
    });

    it('rejects stdio mcp_server without command', () => {
      const result = validateAgentDefinition({
        ...validMinimal,
        mcp_servers: [{ type: 'stdio', name: 'test' }],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects url mcp_server without url', () => {
      const result = validateAgentDefinition({
        ...validMinimal,
        mcp_servers: [{ type: 'url', name: 'test' }],
      });
      expect(result.valid).toBe(false);
    });

    it('rejects an mcp_server name over 255 characters on both arms', () => {
      const longName = 's'.repeat(256);
      expect(validateAgentDefinition({
        ...validMinimal,
        mcp_servers: [{ type: 'url', name: longName, url: 'http://x.test' }],
      }).valid).toBe(false);
      expect(validateAgentDefinition({
        ...validMinimal,
        mcp_servers: [{ type: 'stdio', name: longName, command: 'run' }],
      }).valid).toBe(false);
      // 255 is the bound — it must still pass the name check. The stdio arm
      // also needs a toolset reference for the whole definition to validate,
      // so only the name error is asserted absent here.
      const okName = 's'.repeat(255);
      const res = validateAgentDefinition({
        ...validMinimal,
        mcp_servers: [{ type: 'url', name: okName, url: 'http://x.test' }],
        tools: [{ type: 'mcp_toolset', mcp_server_name: okName, configs: [] }],
      });
      expect(res.valid, JSON.stringify(res.errors)).toBe(true);
    });

    it('rejects an mcp_server url over 2048 characters', () => {
      const url = `http://x.test/${'p'.repeat(2048)}`;
      expect(validateAgentDefinition({
        ...validMinimal,
        mcp_servers: [{ type: 'url', name: 's', url }],
      }).valid).toBe(false);
    });

    it('rejects more than 20 declared mcp_servers', () => {
      const servers = Array.from({ length: 21 }, (_, i) => ({
        type: 'stdio', name: `srv_${i}`, command: 'run',
      }));
      expect(validateAgentDefinition({ ...validMinimal, mcp_servers: servers }).valid).toBe(false);
    });

    it('accepts exactly 20 declared mcp_servers', () => {
      const servers = Array.from({ length: 20 }, (_, i) => ({
        type: 'stdio' as const, name: `srv_${i}`, command: 'run',
      }));
      const tools = servers.map((s) => ({ type: 'mcp_toolset' as const, mcp_server_name: s.name, configs: [] }));
      const res = validateAgentDefinition({ ...validMinimal, mcp_servers: servers, tools });
      expect(res.valid, JSON.stringify(res.errors)).toBe(true);
    });

    it('rejects completely empty object', () => {
      const result = validateAgentDefinition({});
      expect(result.valid).toBe(false);
      expect(result.errors!.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects null input', () => {
      const result = validateAgentDefinition(null);
      expect(result.valid).toBe(false);
    });
  });

  describe('error structure', () => {
    it('provides field path in errors', () => {
      const result = validateAgentDefinition({ name: 123, model: 'gpt-4o', system: 'y' });
      expect(result.valid).toBe(false);
      expect(result.errors![0].path).toBe('name');
      expect(result.errors![0].message).toBeTruthy();
    });
  });

  describe('custom tool grammar', () => {
    const tool = (name: string, schema?: Record<string, unknown>) => ({
      type: 'custom',
      name,
      description: 'a tool',
      input_schema: schema ?? { type: 'object', properties: {} },
    });
    const agentWith = (tools: unknown[]) => ({ name: 'a', model: 'gpt-4o', tools });

    it('accepts a name with a leading digit, underscore, or hyphen', () => {
      // The published character set is letters/digits/underscores/hyphens; a
      // leading letter is not required.
      for (const name of ['9lives', '_private', '-dash', 'a_b-c9']) {
        expect(validateAgentDefinition(agentWith([tool(name)])).valid, name).toBe(true);
      }
    });

    it('accepts a 128-character name and refuses one longer', () => {
      expect(validateAgentDefinition(agentWith([tool('x'.repeat(128))])).valid).toBe(true);
      const tooLong = validateAgentDefinition(agentWith([tool('x'.repeat(129))]));
      expect(tooLong.valid).toBe(false);
    });

    it('refuses the reserved mcp__ and ant__ prefixes', () => {
      for (const name of ['mcp__tool', 'ant__tool', 'mcp__x_y']) {
        const result = validateAgentDefinition(agentWith([tool(name)]));
        expect(result.valid, name).toBe(false);
        expect(result.errors!.some((e) => e.message.includes('reserved prefix')), name).toBe(true);
      }
    });

    it('still refuses a name that collides with a built-in tool', () => {
      const result = validateAgentDefinition(agentWith([tool('bash')]));
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.message.includes('built-in'))).toBe(true);
    });

    it('refuses a top-level oneOf/anyOf/allOf combinator in input_schema', () => {
      for (const key of ['oneOf', 'anyOf', 'allOf']) {
        const result = validateAgentDefinition(agentWith([tool('t', { [key]: [{ type: 'string' }] })]));
        expect(result.valid, key).toBe(false);
        expect(result.errors!.some((e) => e.message.includes('oneOf, anyOf, or allOf')), key).toBe(true);
      }
    });

    it('refuses a $ref anywhere in the schema tree', () => {
      const result = validateAgentDefinition(agentWith([tool('t', {
        type: 'object',
        properties: { nested: { type: 'object', properties: { deep: { $ref: '#/definitions/x' } } } },
      })]));
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.message.includes('$ref'))).toBe(true);
    });

    it('accepts common MCP schema keywords without a combinator or $ref', () => {
      const result = validateAgentDefinition(agentWith([tool('t', {
        type: 'object',
        title: 'Lookup',
        additionalProperties: false,
        properties: { q: { type: 'string' }, 'opts.v2': { type: 'number' } },
        required: ['q'],
      })]));
      expect(result.valid).toBe(true);
    });

    it('refuses a property name outside the published character set', () => {
      const result = validateAgentDefinition(agentWith([tool('t', {
        type: 'object',
        properties: { 'bad name!': { type: 'string' } },
      })]));
      expect(result.valid).toBe(false);
      expect(result.errors!.some((e) => e.message.includes('property name'))).toBe(true);
    });

    it('refuses a tools array over 256 entries', () => {
      const tools = Array.from({ length: 257 }, (_, i) => tool(`tool_${i}`));
      const result = validateAgentDefinition(agentWith(tools));
      expect(result.valid).toBe(false);
    });

    it('accepts a tools array at the 256-entry bound', () => {
      const tools = Array.from({ length: 256 }, (_, i) => tool(`tool_${i}`));
      const result = validateAgentDefinition(agentWith(tools));
      expect(result.valid).toBe(true);
    });
  });
});
