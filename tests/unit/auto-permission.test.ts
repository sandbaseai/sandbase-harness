import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import {
  AUTO_PERMISSION_REASON_HIGH_RISK,
  AUTO_PERMISSION_REASON_INDETERMINATE,
  createAutoPermissionEvaluator,
  parseVerdict,
} from '@/core/session/auto-permission.js';

/**
 * The judge's answer, scripted. A throwing model stands in for every
 * unavailable-provider failure at once: the evaluator's contract is that no
 * transport failure may ever read as an approval.
 */
function judgeModel(answer: string | Error): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'judge',
    supportedUrls: {},
    async doGenerate() {
      if (answer instanceof Error) throw answer;
      return {
        content: [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } },
        warnings: [],
      } as any;
    },
    async doStream() {
      throw new Error('unused');
    },
  } as unknown as LanguageModel;
}

const call = {
  toolName: 'write',
  input: { path: 'note.txt', content: 'hello' },
  toolCallId: 'call_1',
};

describe('parseVerdict', () => {
  it('normalizes the three documented decisions', () => {
    expect(parseVerdict('{"decision":"allow"}')).toEqual({ type: 'allow' });
    expect(parseVerdict('{"decision":"deny"}')).toEqual({
      type: 'deny',
      reasonCode: AUTO_PERMISSION_REASON_HIGH_RISK,
    });
    expect(parseVerdict('{"decision":"ask"}')).toEqual({
      type: 'ask',
      reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE,
    });
  });

  it.each([
    'not json at all',
    '{"decision":"yes"}',
    '{"decision":"allow","extra":',
    '',
    '{"other":1}',
  ])('reads an unreadable answer as ask/indeterminate, never allow: %s', (text) => {
    expect(parseVerdict(text)).toEqual({
      type: 'ask',
      reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE,
    });
  });

  it('tolerates prose around the JSON object', () => {
    expect(parseVerdict('My judgement: {"decision":"allow"} done.')).toEqual({ type: 'allow' });
  });
});

describe('createAutoPermissionEvaluator', () => {
  it('returns the model verdict and the request usage for session accounting', async () => {
    const evaluate = createAutoPermissionEvaluator(judgeModel('{"decision":"deny"}'));

    const evaluation = await evaluate(call);

    expect(evaluation.verdict).toEqual({ type: 'deny', reasonCode: AUTO_PERMISSION_REASON_HIGH_RISK });
    expect(evaluation.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it('grants allow only on an explicit allow', async () => {
    const evaluate = createAutoPermissionEvaluator(judgeModel('{"decision":"allow"}'));

    expect((await evaluate(call)).verdict).toEqual({ type: 'allow' });
  });

  it.each([
    'garbage answer',
    '{"decision":"maybe"}',
  ])('degrades an unreadable verdict to ask, not allow: %s', async (answer) => {
    const evaluate = createAutoPermissionEvaluator(judgeModel(answer));

    expect((await evaluate(call)).verdict).toEqual({
      type: 'ask',
      reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE,
    });
  });

  it('parks the call when the judge request itself fails', async () => {
    const evaluate = createAutoPermissionEvaluator(judgeModel(new Error('provider down')));

    expect((await evaluate(call)).verdict).toEqual({
      type: 'ask',
      reasonCode: AUTO_PERMISSION_REASON_INDETERMINATE,
    });
  });
});
