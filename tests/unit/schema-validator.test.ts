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
});
