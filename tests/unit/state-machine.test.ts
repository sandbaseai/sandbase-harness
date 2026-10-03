/**
 * Unit tests for Session state machine.
 * Validates: Property 6 — Session state machine legal transitions.
 */

import { describe, it, expect } from 'vitest';
import {
  transition,
  canTransition,
  isTerminal,
  InvalidTransitionError,
} from '@/core/session/state-machine.js';
import type { SessionStatus } from '@/types/session.js';

describe('Session State Machine', () => {
  describe('valid transitions', () => {
    const validCases: [SessionStatus, SessionStatus][] = [
      ['queued', 'running'],
      ['queued', 'completed'],
      ['queued', 'failed'],
      ['running', 'paused'],
      ['running', 'requires_action'],
      ['running', 'completed'],
      ['running', 'failed'],
      ['paused', 'running'],
      ['paused', 'completed'],
      ['paused', 'failed'],
      ['requires_action', 'running'],
      ['requires_action', 'completed'],
      ['requires_action', 'failed'],
    ];

    it.each(validCases)('%s → %s should succeed', (from, to) => {
      expect(transition(from, to)).toBe(to);
    });
  });

  describe('invalid transitions', () => {
    const invalidCases: [SessionStatus, SessionStatus][] = [
      ['queued', 'paused'],
      ['queued', 'requires_action'],
      ['running', 'queued'],
      ['paused', 'queued'],
      ['paused', 'requires_action'],
      ['requires_action', 'queued'],
      ['requires_action', 'paused'],
      ['completed', 'running'],
      ['completed', 'queued'],
      ['completed', 'failed'],
      ['failed', 'queued'],
      ['failed', 'running'],
      ['failed', 'completed'],
      ['failed', 'cancelled'],
    ];

    it.each(invalidCases)('%s → %s should throw InvalidTransitionError', (from, to) => {
      expect(() => transition(from, to)).toThrow(InvalidTransitionError);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transitions', () => {
      expect(canTransition('queued', 'running')).toBe(true);
      expect(canTransition('running', 'completed')).toBe(true);
    });

    it('returns false for invalid transitions', () => {
      expect(canTransition('queued', 'paused')).toBe(false);
      expect(canTransition('completed', 'running')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it.each(['completed', 'failed', 'cancelled', 'timed_out', 'cleanup_pending'] as SessionStatus[])('%s is terminal', (status) => {
      expect(isTerminal(status)).toBe(true);
    });

    it('other states are not terminal', () => {
      expect(isTerminal('queued')).toBe(false);
      expect(isTerminal('running')).toBe(false);
      expect(isTerminal('paused')).toBe(false);
      expect(isTerminal('requires_action')).toBe(false);
    });
  });
});
