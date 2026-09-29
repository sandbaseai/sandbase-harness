/**
 * The repair hint a session shows for a model failure.
 *
 * A model failure leaves the session resumable — `paused`, not `failed` — so the
 * transcript, not an error banner, is where the operator looks. The hint has to
 * be attached to the error event, and only to a model failure: telling someone to
 * check their model settings after a sandbox error sends them to the wrong place.
 */

import { describe, expect, it } from 'vitest';
import { modelErrorHint, sessionErrorCode } from '../../apps/console/src/lib/modelErrorHints';
import type { SessionEvent } from '../../apps/console/src/types';

function errorEvent(metadata: unknown): SessionEvent {
  return {
    id: 'evt_1',
    type: 'session.error',
    content: [{ type: 'text', text: 'Provider refused the credential.' }],
    metadata: metadata as Record<string, unknown>,
    created_at: null,
    processed_at: null,
    parent_event_id: null,
  };
}

describe('sessionErrorCode', () => {
  it('reads the code the runtime recorded on the error event', () => {
    const event = errorEvent({ error: { type: 'model_auth_failed', message: 'x', retry_status: 'not_retryable' } });

    expect(sessionErrorCode(event)).toBe('model_auth_failed');
  });

  it('reports nothing for an event that carries no error metadata', () => {
    expect(sessionErrorCode(errorEvent(undefined))).toBeUndefined();
    expect(sessionErrorCode(errorEvent({}))).toBeUndefined();
    expect(sessionErrorCode(errorEvent({ error: 'not an object' }))).toBeUndefined();
    expect(sessionErrorCode(errorEvent({ error: { type: 7 } }))).toBeUndefined();
  });
});

describe('modelErrorHint', () => {
  it('gives every model failure a destination', () => {
    for (const code of ['model_not_found', 'model_provider_not_configured', 'model_config_invalid', 'model_auth_failed']) {
      const hint = modelErrorHint(code);
      expect(hint, code).toBeDefined();
      expect(hint).toContain('Settings');
    }
  });

  it('names the variable for the unresolved-credential case, which arrives as a config failure', () => {
    // The runtime reports an unset `${VAR}` as `model_config_invalid` and names the
    // variable in the message above; the hint says where to put the value.
    expect(modelErrorHint('model_config_invalid')).toContain('environment the runtime was started from');
  });

  it('stays silent for a failure that is not about the model', () => {
    // A sandbox or tool failure must not be given model advice, and an unknown
    // code must not fall through to a generic pointer at model settings. The two
    // codes named here are deliberately outside the error inventory: what is being
    // pinned is the absence of a hint, not the meaning of a published code.
    for (const code of ['sandbox_unavailable', 'tool_execution_failed', undefined, '']) {
      expect(modelErrorHint(code), String(code)).toBeUndefined();
    }
  });
});
