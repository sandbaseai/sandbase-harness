/** Private, bounded, process-local provider replay data. Never an event payload. */
export interface TransientReasoning {
  get(eventId: string): string | undefined;
  remember(eventId: string, text: string): void;
  retain(eventIds: ReadonlySet<string>): void;
}

type Entry = { scope: string; texts: Map<string, string>; bytes: number };

export class TransientReasoningStore {
  private readonly sessions = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly sessionLimit = 1_000_000,
    private readonly totalLimit = 16_000_000,
    private readonly entryLimit = 512,
    private readonly sessionCountLimit = 128,
  ) {}

  forSession(sessionId: string, scope: string): TransientReasoning {
    if (this.sessions.get(sessionId)?.scope !== scope) this.delete(sessionId);
    const entry = this.sessions.get(sessionId) ?? { scope, texts: new Map<string, string>(), bytes: 0 };
    // LRU order is session activity, not time spent waiting for approval.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
    while (this.sessions.size > this.sessionCountLimit) this.delete(this.sessions.keys().next().value!);
    const remove = (id: string) => {
      const previous = entry.texts.get(id);
      if (previous === undefined) return;
      const size = Buffer.byteLength(previous, 'utf8');
      entry.texts.delete(id);
      entry.bytes -= size;
      this.bytes -= size;
    };
    return {
      get: (id) => this.sessions.get(sessionId) === entry ? entry.texts.get(id) : undefined,
      remember: (id, text) => {
        // A handle evicted or superseded while a turn was running cannot
        // resurrect data for a changed provider or a disposed session.
        if (this.sessions.get(sessionId) !== entry) return;
        remove(id);
        const size = Buffer.byteLength(text, 'utf8');
        if (!size || size > this.sessionLimit || size > this.totalLimit) return;
        entry.texts.set(id, text);
        entry.bytes += size;
        this.bytes += size;
        while (entry.bytes > this.sessionLimit || entry.texts.size > this.entryLimit) remove(entry.texts.keys().next().value!);
        while (this.bytes > this.totalLimit) this.delete(this.sessions.keys().next().value!);
      },
      retain: (ids) => {
        if (this.sessions.get(sessionId) !== entry) return;
        for (const id of entry.texts.keys()) if (!ids.has(id)) remove(id);
      },
    };
  }

  delete(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.bytes -= entry.bytes;
    entry.texts.clear();
    entry.bytes = 0;
    this.sessions.delete(sessionId);
  }
}
