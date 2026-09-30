/**
 * The git output cap.
 *
 * `runGit` bounds what a failed git invocation can put into a message, and which
 * characters survive decides whether that message is worth reading at all: the
 * line that explains a failure is the last one git wrote. These cases pin the
 * retention rule directly, including the boundaries the real-git suite can only
 * reach through one long stream.
 */

import { describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHARS, retainTail } from '@/core/resources/github-runtime.js';

describe('git output retention', () => {
  it('keeps an output that fits under the cap intact', () => {
    expect(retainTail('fatal: nope\n', '')).toBe('fatal: nope\n');
  });

  it('keeps exactly the cap at the boundary', () => {
    const at = 'x'.repeat(MAX_OUTPUT_CHARS);
    expect(retainTail(at.slice(0, MAX_OUTPUT_CHARS - 1), 'x')).toBe(at);
    expect(retainTail('x'.repeat(MAX_OUTPUT_CHARS), 'y')).toBe(`${'x'.repeat(MAX_OUTPUT_CHARS - 1)}y`);
  });

  it('drops the front and keeps the tail once the cap is exceeded', () => {
    const retained = retainTail('a'.repeat(MAX_OUTPUT_CHARS), 'fatal: not found\n');

    expect(retained.length).toBe(MAX_OUTPUT_CHARS);
    expect(retained.endsWith('fatal: not found\n')).toBe(true);
    expect(retained.startsWith('a')).toBe(true);
  });

  it('keeps the tail of a single chunk that is itself over the cap', () => {
    const retained = retainTail('', `${'b'.repeat(MAX_OUTPUT_CHARS * 3)}fatal: end`);

    expect(retained.length).toBe(MAX_OUTPUT_CHARS);
    expect(retained.endsWith('fatal: end')).toBe(true);
  });

  it('stays bounded however many chunks arrive, and keeps the newest', () => {
    let stream = '';
    for (let i = 0; i < 100; i += 1) {
      stream = retainTail(stream, `${String(i).padStart(3, '0')}${'c'.repeat(200)}`);
    }

    expect(stream.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(stream.endsWith(`${'099'}${'c'.repeat(200)}`)).toBe(true);
    expect(stream).not.toContain('000');
  });
});
