import { describe, expect, it } from 'vitest';
import { TransientReasoningStore } from '@/core/session/transient-reasoning.js';

describe('private reasoning lifetime and budgets', () => {
  it('isolates sessions and invalidates handles when model/auth/endpoint scope changes', () => {
    const store = new TransientReasoningStore();
    const first = store.forSession('first', 'provider-a');
    first.remember('same-event', 'private');
    expect(store.forSession('second', 'provider-a').get('same-event')).toBeUndefined();
    expect(store.forSession('first', 'provider-a').get('same-event')).toBe('private');
    const changed = store.forSession('first', 'provider-b');
    first.remember('stale', 'must not return');
    expect(first.get('same-event')).toBeUndefined();
    expect(changed.get('same-event')).toBeUndefined();
    expect(changed.get('stale')).toBeUndefined();
  });

  it('evicts whole UTF-8 entries, never returning truncated reasoning', () => {
    const store = new TransientReasoningStore(8, 20);
    const replay = store.forSession('s', 'p');
    replay.remember('one', '你好'); // six bytes
    replay.remember('two', 'abc');
    expect(replay.get('one')).toBeUndefined();
    expect(replay.get('two')).toBe('abc');
    replay.remember('large', '你'.repeat(3));
    expect(replay.get('large')).toBeUndefined();
    replay.remember('two', '12345678');
    expect(replay.get('two')).toBe('12345678');
    replay.remember('two', '');
    expect(replay.get('two')).toBeUndefined();
  });

  it('bounds entry count and prunes compacted anchors without affecting other sessions', () => {
    const store = new TransientReasoningStore(100, 200, 2);
    const replay = store.forSession('s', 'p');
    const other = store.forSession('other', 'p');
    other.remember('a', 'other');
    for (const id of ['a', 'b', 'c']) replay.remember(id, id);
    expect(replay.get('a')).toBeUndefined();
    replay.retain(new Set(['c']));
    expect(replay.get('b')).toBeUndefined();
    expect(replay.get('c')).toBe('c');
    expect(other.get('a')).toBe('other');
  });

  it('bounds total memory by session LRU and cannot resurrect evicted sessions', () => {
    const store = new TransientReasoningStore(10, 10);
    const first = store.forSession('first', 'p'); first.remember('e', '12345');
    const second = store.forSession('second', 'p'); second.remember('e', '12345');
    store.forSession('first', 'p'); // touch first
    const third = store.forSession('third', 'p'); third.remember('e', 'abc');
    expect(first.get('e')).toBe('12345');
    expect(second.get('e')).toBeUndefined();
    second.remember('e', 'stale');
    expect(store.forSession('second', 'p').get('e')).toBeUndefined();
    store.delete('first'); first.remember('e', 'stale');
    expect(store.forSession('first', 'p').get('e')).toBeUndefined();
    // Deletion releases the budget too.
    store.forSession('first', 'p').remember('e', '1234567');
    expect(third.get('e')).toBe('abc');
  });

  it('bounds empty sessions and keeps deleted handles inert', () => {
    const store = new TransientReasoningStore(10, 20, 2, 2);
    const first = store.forSession('first', 'p');
    store.forSession('second', 'p'); store.forSession('third', 'p');
    first.remember('e', 'stale');
    expect(first.get('e')).toBeUndefined();
    const fresh = store.forSession('first', 'p'); fresh.remember('e', 'new');
    first.retain(new Set());
    expect(fresh.get('e')).toBe('new');
  });
});
