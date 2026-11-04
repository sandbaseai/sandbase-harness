/**
 * Canonical agent `model` object profile.
 *
 * The published contract defines `model` as a string or an object with
 * `id` / `speed` / `effort` / `inference_geo`. What matters for an honest local
 * implementation is that a field the runtime cannot honour is refused by name,
 * not accepted and quietly forgotten.
 */

import { describe, expect, it } from 'vitest';
import { validateAgentDefinition } from '@/core/agent/schema.js';
import {
  INFERENCE_GEOS,
  MODEL_EFFORT_LEVELS,
  MODEL_OBJECT_FIELDS,
  describeModelFieldProfile,
  normalizeModelField,
} from '@/core/agent/model-object.js';

describe('normalizeModelField — string form', () => {
  it('accepts a bare id', () => {
    const result = normalizeModelField('claude-opus-5');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ id: 'claude-opus-5' });
  });

  it('rejects an empty string', () => {
    const result = normalizeModelField('   ');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_model');
  });

  it('rejects a non-string, non-object value', () => {
    for (const value of [42, true, ['claude-opus-5'], null]) {
      const result = normalizeModelField(value);
      expect(result.ok).toBe(false);
    }
  });
});

describe('normalizeModelField — object form', () => {
  it('accepts an object with only an id', () => {
    const result = normalizeModelField({ id: 'claude-opus-5' });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ id: 'claude-opus-5' });
  });

  it('carries speed through', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', speed: 'fast' });
    expect(result.ok).toBe(true);
    expect(result.value?.speed).toBe('fast');
  });

  it('rejects an unrecognized speed instead of defaulting', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', speed: 'turbo' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_model_speed');
  });

  it('requires an id', () => {
    const result = normalizeModelField({ speed: 'fast' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_model');
    expect(result.field).toBe('id');
  });
});

describe('normalizeModelField — effort', () => {
  it.each(MODEL_EFFORT_LEVELS)('accepts the documented level %s', (level) => {
    const result = normalizeModelField({ id: 'claude-opus-5', effort: level });
    expect(result.ok).toBe(true);
    expect(result.value?.effort).toBe(level);
  });

  it('accepts the documented object form', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', effort: { type: 'high' } });
    expect(result.ok).toBe(true);
    expect(result.value?.effort).toBe('high');
  });

  it('rejects an unknown level', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', effort: 'maximum' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_model_effort');
    expect(result.field).toBe('effort');
  });

  it('rejects an object form with an unknown type', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', effort: { type: 'maximum' } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_model_effort');
  });

  it('treats an explicit null as absent rather than invalid', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', effort: null });
    expect(result.ok).toBe(true);
    expect(result.value?.effort).toBeUndefined();
  });
});

describe('normalizeModelField — inference_geo', () => {
  it('accepts the documented value set but refuses the pin, naming the field', () => {
    for (const geo of INFERENCE_GEOS) {
      const result = normalizeModelField({ id: 'claude-opus-5', inference_geo: geo });
      expect(result.ok).toBe(false);
      // Recognized and well-formed, yet still refused: the point is that the
      // failure names the field instead of silently ignoring it.
      expect(result.code).toBe('unsupported_model_field');
      expect(result.field).toBe('inference_geo');
      expect(result.message).toContain('inference_geo');
    }
  });

  it('reports an unknown geography as an invalid value, not as unsupported', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', inference_geo: 'eu' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid_inference_geo');
  });
});

describe('normalizeModelField — unknown keys', () => {
  it('rejects an unrecognized field rather than dropping it', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', temperature: 0.5 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported_model_field');
    expect(result.field).toBe('temperature');
    expect(result.message).toContain('Known fields');
  });

  it('names every known field in the error so a caller can self-correct', () => {
    const result = normalizeModelField({ id: 'claude-opus-5', nope: 1 });
    for (const field of MODEL_OBJECT_FIELDS) {
      expect(result.message).toContain(field);
    }
  });
});

describe('describeModelFieldProfile', () => {
  it('covers every contract-defined field exactly once', () => {
    const profile = describeModelFieldProfile();
    expect(profile.map((entry) => entry.field).sort()).toEqual([...MODEL_OBJECT_FIELDS].sort());
  });

  it('records inference_geo as unavailable with a reason', () => {
    const geo = describeModelFieldProfile().find((entry) => entry.field === 'inference_geo');
    expect(geo?.status).toBe('unavailable');
    // `reason` only exists on the partial/unavailable variants, so narrow on
    // status rather than reaching through the union with an optional access.
    if (geo?.status !== 'unavailable') throw new Error(`expected unavailable, got ${geo?.status}`);
    expect(geo.reason).toBeTruthy();
  });

  it('records effort as capability-gated rather than universally executed', () => {
    // The value reaches Anthropic requests on models whose capability entry
    // lists the level; admission refuses a level a listed model cannot take.
    const effort = describeModelFieldProfile().find((entry) => entry.field === 'effort');
    expect(effort?.status).toBe('partial');
    if (effort?.status !== 'partial') throw new Error(`expected partial, got ${effort?.status}`);
    expect(effort.reason).toContain('providerOptions.anthropic.effort');
  });

  it('records speed as capability-gated with the local extension named', () => {
    const speed = describeModelFieldProfile().find((entry) => entry.field === 'speed');
    expect(speed?.status).toBe('partial');
    if (speed?.status !== 'partial') throw new Error(`expected partial, got ${speed?.status}`);
    expect(speed.reason).toContain('fast mode');
    expect(speed.reason).toContain('extended');
  });
});

describe('model object profile is wired into the agent definition validator', () => {
  const definition = (model: unknown) => ({
    name: 'Model Agent',
    model,
    system: 'You are terse.',
  });

  it('carries effort through the validator and a read-back', () => {
    const result = validateAgentDefinition(definition({ id: 'claude-opus-5', effort: 'high' }));
    expect(result.valid).toBe(true);
    expect(result.data?.model).toBe('claude-opus-5');
    // Inside the model profile it belongs to, which is the shape the read
    // projection returns; a sibling of `model_config` was stored but unreadable.
    expect(result.data?.model_config).toEqual({ id: 'claude-opus-5', speed: 'standard', effort: 'high' });
  });

  it('accepts the local `model_config` spelling of effort instead of dropping it', () => {
    const result = validateAgentDefinition({
      name: 'Model Agent',
      model: 'claude-opus-5',
      system: 'You are terse.',
      model_config: { id: 'claude-opus-5', speed: 'fast', effort: 'low' },
    });
    expect(result.valid).toBe(true);
    expect(result.data?.model_config).toEqual({ id: 'claude-opus-5', speed: 'fast', effort: 'low' });
  });

  it('refuses a well-formed inference_geo pin by name', () => {
    const result = validateAgentDefinition(definition({ id: 'claude-opus-5', inference_geo: 'us' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: 'model.inference_geo',
        message: expect.stringContaining('inference-geography control'),
      }),
    ]);
  });

  it('refuses an unrecognized field and lists the known ones', () => {
    const result = validateAgentDefinition(definition({ id: 'claude-opus-5', region: 'us-east' }));
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain('inference_geo');
  });

  it('keeps rejecting a missing model at path model', () => {
    const result = validateAgentDefinition({ name: 'No Model', system: 'hi' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ path: 'model' }));
  });
});

it('normalizes object-form effort through the full definition schema', () => {
  const result = validateAgentDefinition({ name: 'roundtrip', system: '', model: {
    id: 'claude-opus-5-5', speed: 'fast', effort: { type: 'high' },
  } });
  expect(result.valid).toBe(true);
  expect(result.data?.model_config).toEqual({ id: 'claude-opus-5-5', speed: 'fast', effort: 'high' });
});
