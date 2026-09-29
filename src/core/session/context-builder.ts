import { eventsToMessages } from './events-to-messages.js';
import type { EventLogger } from './event-logger.js';
import type { ContextCompactor } from './context-compactor.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { Session, SessionEvent } from '@/types/session.js';
import { composeSystemPrompt, type Skill } from '@/core/skills/loader.js';
import type { MemoryProvider } from '@/core/memory/memory-provider.js';
import { memoryBindingIsWritable, resolveMemoryBindings } from '@/core/memory/bindings.js';
import { getAgentSkillIds } from '@/core/agent/standard.js';
import type { SandboxProviderType } from '@/types/sandbox.js';
import { renderSessionResources } from './session-resource-prompt.js';

type SessionAwareMemoryProvider = MemoryProvider & {
  addForSession?: (
    storeId: string,
    content: string,
    metadata: Record<string, unknown> | undefined,
    sessionId: string,
  ) => Promise<string>;
};

export interface ContextBuilderDeps {
  eventLogger: EventLogger;
  compactor?: ContextCompactor;
  skills?: Skill[];
  memory?: MemoryProvider;
  /** API-managed memory_records provider selected by memory_store resources. */
  memoryRecords?: MemoryProvider;
  memoryStoreName?: (storeId: string) => string | undefined;
}

export interface BuiltContext {
  systemPrompt: string;
  messages: ReturnType<typeof eventsToMessages>;
}

export interface ContextBuildOptions {
  /**
   * Skills discovered inside a repository mounted for this session, already
   * read out of that sandbox.
   *
   * Deliberately not filtered by the agent's `skills` list: attaching the
   * repository is what puts its skills in the instruction boundary, so gating
   * them on a per-agent assignment would drop half of what the caller declared.
   */
  repositorySkills?: Skill[];
  /**
   * Backend the session's environment resolves to, as reported by the lifecycle.
   *
   * Used to name the paths a mounted resource can be reached by: the canonical
   * path always, plus the sandbox-relative spelling a shell needs on the local
   * backend, where a command runs on the host rather than in the sandbox.
   */
  sandboxProvider?: SandboxProviderType;
}

export class ContextBuilder {
  constructor(private readonly deps: ContextBuilderDeps) {}

  async build(
    session: Session,
    agent: AgentDefinition,
    event: UserEvent,
    model: unknown | undefined,
    broadcast: (event: SessionEvent) => void,
    options?: ContextBuildOptions,
  ): Promise<BuiltContext> {
    await this.compactIfNeeded(session, model, broadcast);

    const events = this.deps.eventLogger.getEvents(session.id);
    const messages = eventsToMessages(events);

    let systemPrompt = this.composeSystemPrompt(agent, options?.repositorySkills);
    if (this.deps.memory && session.contextId) {
      systemPrompt = await this.injectMemory(systemPrompt, session.contextId, event);
    }
    const bindings = resolveMemoryBindings(session.resources, this.deps.memoryStoreName);
    if (this.deps.memoryRecords && bindings.length > 0) {
      systemPrompt = await this.injectMountedMemory(systemPrompt, bindings, event);
    }

    const resources = renderSessionResources(session.resources, {
      sandboxProvider: options?.sandboxProvider,
    });
    if (resources) systemPrompt = `${systemPrompt}\n\n${resources}`;

    return { systemPrompt, messages };
  }

  async extractMemory(session: Session, event: UserEvent): Promise<void> {
    if (event.type !== 'user.message') return;
    const text = (event.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block: any) => block.text)
      .join(' ')
      .trim();
    if (!text) return;

    // Preserve the legacy context_id provider exactly for existing sessions.
    if (this.deps.memory && session.contextId) {
      try {
        await this.deps.memory.add(session.contextId, text, { source: 'user.message' });
      } catch {
        // A legacy provider failure must not suppress mounted-store extraction.
      }
    }

    if (!this.deps.memoryRecords) return;
    const memoryRecords = this.deps.memoryRecords as SessionAwareMemoryProvider;
    for (const binding of resolveMemoryBindings(session.resources, this.deps.memoryStoreName).filter(memoryBindingIsWritable)) {
      try {
        if (memoryRecords.addForSession) {
          await memoryRecords.addForSession(binding.storeId, text, { source: 'user.message' }, session.id);
        } else {
          await memoryRecords.add(binding.storeId, text, { source: 'user.message' });
        }
      } catch {
        // Memory extraction is best-effort and isolated per mounted store.
      }
    }
  }

  composeSystemPrompt(agent: AgentDefinition, repositorySkills?: Skill[]): string {
    const assigned = getAgentSkillIds(agent);
    const discovered = repositorySkills ?? [];
    if (discovered.length === 0) {
      return composeSystemPrompt(agent.system, assigned, this.deps.skills ?? []);
    }
    // One call rather than a second appended block: the rendering is the
    // existing `# Available Skills` section, and two of them would read as two
    // separate capability lists for what is one instruction boundary.
    return composeSystemPrompt(
      agent.system,
      [...assigned, ...discovered.map((skill) => skill.name)],
      [...(this.deps.skills ?? []), ...discovered],
    );
  }

  private async compactIfNeeded(
    session: Session,
    model: unknown | undefined,
    broadcast: (event: SessionEvent) => void,
  ): Promise<void> {
    // Strategies such as Pi own their model transport, so compaction cannot
    // construct or invoke an AI SDK model on their behalf.
    if (!this.deps.compactor || !model) return;

    const projected = eventsToMessages(this.deps.eventLogger.getEvents(session.id));
    if (!this.deps.compactor.shouldCompact(projected)) return;

    try {
      const result = await this.deps.compactor.compact(projected, model as any);
      if (result) {
        const boundary = this.deps.eventLogger.append(session.id, {
          type: 'agent.thread_context_compacted',
          content: [{ type: 'text', text: result.summary }],
        });
        broadcast(boundary);
      }
    } catch {
      // Compaction is best-effort — a summarize failure must not fail the turn.
    }
  }

  private async injectMemory(
    systemPrompt: string,
    contextId: string,
    event: UserEvent,
  ): Promise<string> {
    if (!this.deps.memory) return systemPrompt;
    const query = event.type === 'user.message'
      ? (event.content ?? []).filter((b) => b.type === 'text').map((b: any) => b.text).join(' ')
      : '';
    try {
      const memories = await this.deps.memory.search(contextId, query, 5);
      if (memories.length === 0) return systemPrompt;
      const block = memories.map((memory) => `- ${memory.content}`).join('\n');
      return `${systemPrompt}\n\n# Relevant Memory\n\nFrom earlier related sessions:\n${block}`;
    } catch {
      return systemPrompt;
    }
  }

  private async injectMountedMemory(
    systemPrompt: string,
    bindings: ReturnType<typeof resolveMemoryBindings>,
    event: UserEvent,
  ): Promise<string> {
    if (!this.deps.memoryRecords) return systemPrompt;
    const query = event.type === 'user.message'
      ? (event.content ?? []).filter((b) => b.type === 'text').map((b: any) => b.text).join(' ')
      : '';
    const sections: string[] = [];
    for (const binding of bindings) {
      const description = [
        `Mount path: ${binding.mountPath}`,
        `Access: ${binding.access}`,
        ...(binding.instructions ? [`Instructions: ${binding.instructions}`] : []),
      ].join('\n');
      try {
        const memories = await this.deps.memoryRecords.search(binding.storeId, query, 5);
        const records = memories.length > 0
          ? `\n${memories.map((memory) => `- ${memory.content}`).join('\n')}`
          : '\n(no matching memories)';
        sections.push(`${description}${records}`);
      } catch {
        sections.push(`${description}\n(store unavailable)`);
      }
    }
    return sections.length > 0
      ? `${systemPrompt}\n\n# Mounted Memory Stores\n\n${sections.join('\n\n')}`
      : systemPrompt;
  }
}
