/**
 * Unit tests for the Context Compactor (R9.15, Property 11).
 */

import { describe, it, expect } from 'vitest';
import {
  ContextCompactor,
  estimateMessagesTokens,
} from '@/core/session/context-compactor.js';
import type { Message } from '@/core/session/events-to-messages.js';
import type { LanguageModel } from 'ai';

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** A fake model that returns a fixed summary via generateText. */
function fakeModel(summaryText: string): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text: summaryText }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      } as any;
    },
    async doStream() {
      throw new Error('not used');
    },
  } as unknown as LanguageModel;
}

describe('ContextCompactor', () => {
  describe('shouldCompact', () => {
    it('does not trigger for small histories', () => {
      const c = new ContextCompactor({ contextWindowTokens: 1000, triggerFraction: 0.8 });
      const msgs = [userMsg('short')];
      expect(c.shouldCompact(msgs)).toBe(false);
    });

    it('triggers when estimated tokens exceed the threshold', () => {
      const c = new ContextCompactor({ contextWindowTokens: 100, triggerFraction: 0.8 });
      // ~200 chars ≈ 50 tokens per message; 4 messages ≈ 200 tokens > 80
      const big = 'x'.repeat(400);
      const msgs = [userMsg(big), userMsg(big)];
      expect(c.shouldCompact(msgs)).toBe(true);
    });

    it('respects an explicit context window arg', () => {
      const c = new ContextCompactor();
      const big = 'x'.repeat(4000); // ~1000 tokens
      expect(c.shouldCompact([userMsg(big)], 500)).toBe(true);
      expect(c.shouldCompact([userMsg(big)], 1_000_000)).toBe(false);
    });
  });

  describe('compact', () => {
    it('returns null when there is too little history', async () => {
      const c = new ContextCompactor({ preserveTailMessages: 4 });
      const result = await c.compact([userMsg('a'), userMsg('b')], fakeModel('summary'));
      expect(result).toBeNull();
    });

    it('summarizes older messages and preserves the tail', async () => {
      const c = new ContextCompactor({ preserveTailMessages: 2 });
      const msgs = [
        userMsg('message 1'),
        userMsg('message 2'),
        userMsg('message 3'),
        userMsg('message 4'),
        userMsg('message 5'),
      ];
      const result = await c.compact(msgs, fakeModel('this is the summary'));
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('this is the summary');
      expect(result!.preservedTailCount).toBe(2);
      expect(result!.tokensBefore).toBeGreaterThan(0);
    });

    it('post-compaction token estimate is lower than pre when history is large', async () => {
      const c = new ContextCompactor({ preserveTailMessages: 1 });
      const big = 'word '.repeat(500);
      const msgs = [userMsg(big), userMsg(big), userMsg(big), userMsg('recent')];
      const result = await c.compact(msgs, fakeModel('tiny summary'));
      expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('is roughly chars/4', () => {
      const msg = userMsg('x'.repeat(400)); // 400 chars
      // JSON.stringify adds some overhead, so >= 100
      expect(estimateMessagesTokens([msg])).toBeGreaterThanOrEqual(100);
    });
  });
});
