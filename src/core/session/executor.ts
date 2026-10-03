/**
 * Session Executor
 *
 * Wires together the full execution pipeline:
 * SessionManager.sendEvent → load agent → create model → provision sandbox →
 * build messages (eventsToMessages) → execute Strategy → broadcast events
 *
 * Sandbox lifecycle: one Sandbox instance is provisioned per Session on the
 * first turn and REUSED across subsequent turns (1:1 Session↔Sandbox binding,
 * R9.3). It is only destroyed via cleanupSession() when the Session reaches a
 * terminal state (stop/delete/failed).
 */

import { dirname, resolve, sep } from 'node:path';
import type { SessionExecutor, ExecuteOptions } from './session-manager.js';
import type { Session, SessionEvent, SessionLoopEngine } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { TurnTrigger } from '@/types/session.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance, SandboxProvider, EnvironmentConfig } from '@/types/sandbox.js';
import type { SandboxProviderRegistry } from '@/sandbox/registry.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import type { McpServerStatus } from '@/core/mcp/mcp-manager.js';
import { EventLogger } from './event-logger.js';
import { parkedCalls } from './parked-calls.js';
import { ContextCompactor } from './context-compactor.js';
import { parseSkill, type Skill } from '@/core/skills/loader.js';
import type { MemoryProvider } from '@/core/memory/memory-provider.js';
import type { MemoryMountAdapter } from '@/core/memory/mount-adapter.js';
import { resolveMemoryBindings } from '@/core/memory/bindings.js';
import type { SnapshotManager } from './snapshot-manager.js';
import { collectSessionOutputs, type SessionOutputFile } from './session-outputs.js';
import {
  SandboxLifecycle,
  type FileArtifactReader,
  type GithubRepositoryMaterializer,
  type SandboxLifecycleLogger,
} from './sandbox-lifecycle.js';
import { ContextBuilder } from './context-builder.js';
import { DelegationService } from './delegation-service.js';
import { ToolResolver, type SandboxCredentials } from './tool-resolver.js';
import { createCredentialRedactor, clearCredentialInjectionBundle } from '@/core/credentials/redaction.js';
import type { CredentialInjectionBundle, CredentialInjectionTarget } from '@/core/credentials/injection.js';
import { getCustomToolNames, getToolsRequiringConfirmation } from '@/core/agent/standard.js';
import {
  assertPiAgentCanExecute,
  assertPiEnvironmentCanExecute,
  assertPiUserEventCanExecute,
} from './pi-policy.js';
import {
  hasSteering,
  type LoopEngineSteerInput,
  type LoopEngineSteerReceipt,
} from '@/strategy/loop-engine/adapter.js';
import type { WebFetchOverrides } from '@/core/web/web-fetch.js';

export interface ExecutorDeps {
  agents: AgentDefinition[];
  modelRegistry: ModelRegistry;
  /** Default sandbox provider (used when no registry/env resolution applies). */
  sandboxProvider: SandboxProvider;
  /** Optional registry to select a provider by Environment sandbox_provider. */
  sandboxRegistry?: SandboxProviderRegistry;
  /** Resolve a session environment id to its runtime configuration. */
  resolveEnvironmentConfig?: (environmentId: string) => EnvironmentConfig | undefined;
  /** Resolve an agent id from durable storage. */
  resolveAgent?: (agentId: string) => AgentDefinition | undefined;
  strategy: AgentStrategy;
  /** Resolve a strategy for the engine frozen on a persisted session. */
  resolveStrategy?: (loopEngine: SessionLoopEngine) => AgentStrategy;
  /**
   * Release strategy-owned engine resources bound to a session.
   *
   * Called on a terminal session state, before the sandbox and work directory
   * are torn down. A strategy that owns a child process (Pi owns one per
   * session) implements this; a strategy that owns nothing leaves it unset.
   */
  disposeStrategySessions?: (sessionId: string) => Promise<void> | void;
  eventLogger: EventLogger;
  /** Optional context compactor. If provided, long histories are summarized. */
  compactor?: ContextCompactor;
  /** Loaded skills, injected into agent system prompts by name (R4). */
  skills?: Skill[];
  /** Root directory containing explicit skill packages for Pi --skill flags. */
  skillsDir?: string;
  /** Optional long-term memory provider, scoped by context_id (R9.16–18). */
  memory?: MemoryProvider;
  /** API-managed memory_records provider for mounted stores. */
  memoryRecords?: MemoryProvider;
  /** Path-addressed memory adapter; absent means mounted calls fail closed. */
  memoryMount?: MemoryMountAdapter;
  memoryStoreName?: (storeId: string) => string | undefined;
  /** Optional workspace snapshot manager (R9.11). */
  snapshots?: SnapshotManager;
  /** Workspace fallback when an agent does not set max_turns. */
  defaultMaxSteps?: number;
  /**
   * WebFetch transport overrides (resolver, address guard, limits).
   *
   * Constructor-level only, so no model-facing or API-facing input can relax
   * the guard.
   */
  webFetch?: WebFetchOverrides;
  /** Optional sink for sandbox capability-gap warnings. */
  logger?: SandboxLifecycleLogger;
  /**
   * Read an attached file resource's bytes, so provisioning can mount it.
   *
   * Optional: an embedder that never attaches a file resource passes nothing,
   * and a session that *does* attach one fails loudly at provisioning rather
   * than starting without the file the caller declared. The production
   * composition supplies it.
   */
  fileArtifactReader?: FileArtifactReader;
  /**
   * Mount a `github_repository` resource into a session's sandbox.
   *
   * Optional on the same terms as {@link fileArtifactReader}: absent means a
   * session with a repository resource fails at provisioning with the gap
   * named, instead of starting against a tree the caller did not ask for.
   */
  githubMaterializer?: GithubRepositoryMaterializer;
  /**
   * Resolve a session's vault credentials for a turn.
   *
   * Optional: a runtime with no vault store passes nothing, and a session with no
   * vaults resolves to an empty bundle. The resolver enforces the network policy
   * before it decrypts anything, so a credential this turn cannot use arrives in
   * `denied` rather than in the environment. The target names what the call is
   * addressed to; a shell command names nothing.
   */
  resolveCredentialInjections?: (sessionId: string, target?: CredentialInjectionTarget) => CredentialInjectionBundle;
  /**
   * Publish the files an agent wrote under the session output directory.
   *
   * Optional because an embedder with no Files API has nowhere to put them.
   * Called after every turn, with whatever the sandbox currently holds.
   */
  sessionOutputSink?: (sessionId: string, files: SessionOutputFile[]) => void | Promise<void>;
}

export class DefaultSessionExecutor implements SessionExecutor {
  private readonly sandboxLifecycle: SandboxLifecycle;
  private readonly contextBuilder: ContextBuilder;
  private readonly delegationService: DelegationService;
  private readonly toolResolver: ToolResolver;

  constructor(private readonly deps: ExecutorDeps) {
    // Named rather than spread: these are the two dependencies that decide
    // whether a session's declared resources can be materialized at all, and a
    // field silently dropped here would turn a wired runtime back into one that
    // refuses at provisioning.
    this.sandboxLifecycle = new SandboxLifecycle({
      sandboxProvider: deps.sandboxProvider,
      sandboxRegistry: deps.sandboxRegistry,
      resolveEnvironmentConfig: deps.resolveEnvironmentConfig,
      snapshots: deps.snapshots,
      fileArtifactReader: deps.fileArtifactReader,
      githubMaterializer: deps.githubMaterializer,
      logger: deps.logger,
    });
    this.contextBuilder = new ContextBuilder({
      eventLogger: deps.eventLogger,
      compactor: deps.compactor,
      skills: deps.skills,
      memory: deps.memory,
      memoryRecords: deps.memoryRecords,
      memoryStoreName: deps.memoryStoreName,
    });
    this.delegationService = new DelegationService({
      agents: deps.agents,
      modelRegistry: deps.modelRegistry,
      strategy: deps.strategy,
      resolveStrategy: deps.resolveStrategy,
      // Route sub-agent sandboxes through the lifecycle so they resolve to the
      // parent session's backend instead of always landing on local.
      provisionSandbox: (session, sandboxId) => this.sandboxLifecycle.provisionDetached(session, sandboxId),
      composeSystemPrompt: (agent) => this.contextBuilder.composeSystemPrompt(agent),
      // The child's sandbox is provisioned through the same lifecycle, so the
      // child's prompt describes its resources against the same backend as the
      // parent's: a sub-agent that was told the canonical path only, while its
      // parent was told both spellings, would read the same mount differently.
      buildMemoryContext: async (childSession, childAgent, childEvent) => (await this.contextBuilder.build(
        childSession,
        childAgent,
        childEvent,
        undefined,
        () => {},
        { sandboxProvider: this.sandboxLifecycle.resolveProviderType(childSession) },
      )).systemPrompt,
      buildSandboxTools: (agent, sandbox, parentSession) => this.toolResolver.buildSandboxTools(
        agent,
        sandbox,
        resolveMemoryBindings(parentSession?.resources, deps.memoryStoreName),
        deps.memoryMount ? { adapter: deps.memoryMount, sessionId: parentSession?.id ?? 'unknown' } : undefined,
      ),
      resolveSkillDirs: (agent) => this.skillDirsFor(agent),
    });
    this.toolResolver = new ToolResolver({
      delegationService: this.delegationService,
      webFetch: deps.webFetch,
      memoryMount: deps.memoryMount,
      memoryStoreName: deps.memoryStoreName,
      // The same resolver the turn uses for sandbox commands, so a vault reaches
      // an MCP server by the same policy decision that governs a shell command.
      resolveCredentialInjections: deps.resolveCredentialInjections,
    });
  }

  async *execute(
    session: Session,
    event: TurnTrigger,
    options?: ExecuteOptions,
  ): AsyncIterable<SessionEvent> {
    const { agents, modelRegistry, eventLogger } = this.deps;
    const strategy = this.strategyFor(session);

    // A steer is not a turn, so it must not be executed as one. `execute()` is
    // serialized per session, which means a steer routed through it would apply
    // only after the turn it was meant to influence had ended — the runtime would
    // then have reported a delivery that changed nothing. The Session Manager
    // delivers steers through `steer()` instead; this guard covers a direct
    // executor caller, which has no receipt channel and so is refused rather than
    // silently dropped.
    if (event.type === 'user.steer') {
      throw new Error('user.steer is delivered through the steering side channel, not as a turn');
    }

    // 1. Load agent definition
    const agent = session.agentDefinition
      ?? this.deps.resolveAgent?.(session.agentId)
      ?? agents.find((a) => a.name === session.agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${session.agentId}`);
    }
    if (session.loopEngine === 'pi') {
      // A direct executor caller must fail closed before any model construction,
      // sandbox provisioning, confirmation handling, event persistence, or child launch.
      assertPiAgentCanExecute(agent);
      const environment = this.deps.resolveEnvironmentConfig?.(session.environmentId);
      assertPiEnvironmentCanExecute(environment?.sandbox_provider ?? this.deps.sandboxProvider.type);
      // An internal resume carries no user payload to validate — it re-enters
      // the loop on the transcript the log already holds.
      if (event.type !== 'internal.resume_after_budget') {
        assertPiUserEventCanExecute(event);
      }
    }

    // Pi owns model transport, but it still receives the selected concrete
    // model configuration. Builtin strategies retain AI SDK construction and
    // do not need registry resolution before their existing model factory.
    const modelConfig = strategy.requiresModel === false
      ? modelRegistry.resolveModelConfig(agent.model)
      : undefined;
    const model = strategy.requiresModel === false
      ? undefined
      : modelRegistry.createModel(agent.model, { retryObserver: options?.retryObserver });

    // 3. Provision sandbox (or reuse the one bound to this session)
    const sandbox = await this.sandboxLifecycle.getOrProvision(session);

    // 3a. Handle a tool confirmation (A5): run or deny the pending tool, append
    // its result so the model turn below continues with a paired sequence.
    // A stale confirmation (the referenced call already resolved — e.g. a
    // double-click or a queued click on an older card) must not start a model
    // turn: the log may hold other unpaired tool calls awaiting their own
    // confirmation, and the request would carry an unpaired tool call that
    // providers reject with "Tool result is missing".
    //
    // Pi is excluded on purpose. Its gated tools are Pi's own native tools, so
    // routing a Pi gate through `ToolResolver` would execute the call in the
    // Harness sandbox while Pi stayed blocked on a decision it never received.
    // The Pi strategy resolves its own gate.
    if (event.type === 'user.tool_confirmation' && session.loopEngine !== 'pi') {
      const resolution = await this.toolResolver.handleToolConfirmation(
        session,
        agent,
        sandbox,
        event,
        eventLogger,
        options?.broadcast ?? (() => {}),
      );
      if (!resolution.handled) return;
    }

    // 3b. A turn may start only once nothing is parked. The answer just handled
    // is one of possibly several calls the session is waiting on, and the
    // resume-turn request carries every parked call the log still holds. Starting
    // it while another call is unanswered builds a request with an unpaired tool
    // call, which providers reject with "Tool result is missing for tool call
    // <id>" — terminating a session for what was a documented, well-formed
    // answer. The published client answers each id in `stop_reason.event_ids` in
    // turn, so the intermediate answers are the normal case, not an edge case.
    //
    // The parked set is read from `parkedCalls`, the same definition the
    // `stop_reason` projection publishes from, so "the array is non-empty" and
    // "no turn may start" cannot drift apart.
    //
    // Pi is excluded on the same grounds as 3a: it resolves its own gate and
    // appends the paired result when that call actually finishes, so at this
    // point its gated call is legitimately still in the log and holding the turn
    // would leave the decision undelivered.
    const answeredAParkedCall = event.type === 'user.custom_tool_result'
      || (event.type === 'user.tool_confirmation' && session.loopEngine !== 'pi');
    if (answeredAParkedCall && parkedCalls(eventLogger.getEvents(session.id)).length > 0) {
      options?.onRequiresAction?.();
      return;
    }

    const broadcast = options?.broadcast ?? (() => {});

    // 4. Build context: compaction, Event_Log projection, skills, and memory.
    // A repository mounted for this session ships its own `.claude/skills`; the
    // instructions are read out of the sandbox they were written to, so the
    // prompt and the tree the agent can see cannot disagree.
    //
    // The backend is asked of the lifecycle rather than read off the session,
    // because the paths a resource can be reached by depend on where the sandbox
    // is: the same mount is an absolute path for a command in a container and a
    // sandbox-relative one for a command on the local host.
    const repositorySkills = await this.loadRepositorySkills(session, sandbox);
    const { systemPrompt, messages } = await this.contextBuilder.build(
      session,
      agent,
      event,
      model,
      broadcast,
      {
        repositorySkills,
        sandboxProvider: this.sandboxLifecycle.resolveProviderType(session),
      },
    );

    // 5. Build tools: built-in sandbox tools, MCP tools, delegation tools, and
    // confirm-required stripping. A shell command declares no target host, so the
    // resolver is asked without one: an `unrestricted` credential is injected and
    // a `limited` one is denied, exactly as the policy already decides.
    const resolvedCredentials = this.deps.resolveCredentialInjections?.(session.id);
    const credentials: SandboxCredentials | undefined = resolvedCredentials
      ? { env: { ...resolvedCredentials.environment }, redactor: createCredentialRedactor(resolvedCredentials) }
      : undefined;
    const tools = await this.toolResolver.resolveTools(session, agent, sandbox, credentials);
    // A custom tool call is parked work, not executable work: the runtime
    // surfaces it and waits for the caller's result, so it is routed through the
    // same requires_action path an approval takes.
    const confirmTools = [...getToolsRequiringConfirmation(agent), ...getCustomToolNames(agent)];

    // 6. Execute strategy
    const context: StrategyContext = {
      session: { ...session, agentDefinition: agent },
      userEvent: event,
      systemPrompt,
      messages: messages as any,
      modelConfig,
      model,
      ...(this.deps.skillsDir ? { skillDirs: this.skillDirsFor(agent) } : {}),
      tools,
      // Names the strategy must expose but never execute. Derived from the same
      // list that feeds confirmTools so the two cannot disagree about which
      // tools are caller-executed.
      customToolNames: new Set(getCustomToolNames(agent)),
      sandbox,
      eventLog: eventLogger,
      broadcast, // real SSE broadcast wired from SessionManager
      config: {
        maxSteps: agent.max_turns ?? this.deps.defaultMaxSteps ?? 25,
        temperature: agent.temperature ?? 0.7,
        confirmTools,
        onRequiresAction: options?.onRequiresAction,
        budgetExhausted: options?.budgetExhausted,
      },
      abortSignal: options?.abortSignal,
    };

    try {
      for await (const evt of strategy.execute(context)) {
        yield evt;
      }

      // 7. Extract key facts into long-term memory (R9.18), scoped by context_id.
      await this.contextBuilder.extractMemory(session, event).catch(() => {});

      // 8. Snapshot the workspace after the turn if enabled (R9.11).
      this.sandboxLifecycle.snapshotAfterTurn(session, sandbox);

      // 9. Publish the files the agent wrote under the session output root.
      await this.publishSessionOutputs(session, sandbox);
      // NOTE: no sandbox/MCP cleanup here — they persist for the session
      // lifetime and are destroyed via cleanupSession() on terminal states.
    } finally {
      // The turn is the lifetime of a vault secret: the redactor and the bundle it
      // was built from are cleared here, whether the strategy finished or threw.
      credentials?.redactor.clear();
      clearCredentialInjectionBundle(resolvedCredentials);
    }
  }

  /**
   * Reconnect a session's MCP servers through their credential resolver.
   *
   * The runtime calls this after a vault rotation, so the next MCP tool call is
   * authenticated with the value the session holds now rather than the one its
   * transports were built with.
   */
  async refreshSessionMcpCredentials(sessionId: string): Promise<void> {
    await this.toolResolver.refreshSessionMcpCredentials(sessionId);
  }

  /**
   * Drop the session's MCP connections so the next turn reconnects against the
   * session's current agent definition.
   *
   * Called after a session update replaced `agent.tools`/`agent.mcp_servers`.
   * A credential refresh would reconnect the servers the old definition named
   * under the old toolset's admission rule, because both were captured when the
   * manager connected — the only correct answer to a changed server set or
   * admission set is to connect again. Only MCP state is torn down: the
   * sandbox stays bound for the session's lifetime.
   */
  async resetSessionMcpConnections(sessionId: string): Promise<void> {
    await this.toolResolver.cleanupSession(sessionId);
  }

  /**
   * Publish the files an agent wrote under `/mnt/session/outputs`.
   *
   * Only meaningful when a sink is wired: an embedder with no Files API has
   * nowhere to put them. Failures are swallowed because the turn itself has
   * already completed — a collection error must not turn a successful agent run
   * into a failed session, and the next turn re-reads the same directory.
   */
  private async publishSessionOutputs(session: Session, sandbox: SandboxInstance): Promise<void> {
    const sink = this.deps.sessionOutputSink;
    if (!sink) return;
    try {
      const outputs = await collectSessionOutputs(sandbox);
      if (outputs.length === 0) return;
      await sink(session.id, outputs);
    } catch {
      // best-effort: the output directory is re-read on the next turn
    }
  }

  /**
   * Read the skills a mounted repository ships, out of the sandbox.
   *
   * The names were discovered when the repository was materialized; the
   * instructions live in `SKILL.md` inside the mounted tree, so they are read
   * back through the same sandbox. A skill that was discovered but cannot be
   * read fails the turn: the repository is part of the instruction boundary the
   * caller declared, and starting without it would run the session against a
   * different contract. A file that is readable but carries no usable
   * frontmatter is reported and skipped, because that is a property of the
   * repository's own content rather than of the runtime.
   */
  private async loadRepositorySkills(session: Session, sandbox: SandboxInstance): Promise<Skill[]> {
    const files = this.sandboxLifecycle.discoveredRepositorySkillFiles(session.id);
    if (files.length === 0) return [];

    const skills: Skill[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await sandbox.readFile(file.path);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Repository skill ${file.name} could not be read: ${reason}`);
      }
      const skill = parseSkill(content, file.name, file.path);
      if (!skill) {
        this.deps.logger?.warn('repository skill skipped: no usable frontmatter', {
          session: session.id,
          skill: file.name,
          path: file.path,
        });
        continue;
      }
      skills.push(skill);
    }
    return skills;
  }

  private skillDirsFor(agent: AgentDefinition): string[] {    const root = this.deps.skillsDir;
    if (!root) return [];
    const resolvedRoot = resolve(root);
    const byId = new Map((this.deps.skills ?? []).map((skill) => [skill.id, skill]));
    return (agent.skills ?? []).flatMap((reference) => {
      const skill = byId.get(reference.skill_id);
      if (!skill?.file) return [];
      const file = resolve(resolvedRoot, skill.file);
      if (file !== resolvedRoot && !file.startsWith(`${resolvedRoot}${sep}`)) return [];
      return [dirname(file)];
    });
  }

  /**
   * Destroy the sandbox + MCP connections bound to a session. Called by
   * SessionManager when the session reaches a terminal state.
   */
  async cleanupSession(sessionId: string): Promise<void> {
    // Engine-owned children stop first. A session-owned child still running
    // would keep using a work directory the runtime has just released, and its
    // cleanup failures (such as `pi_cleanup_pending`) are ownership failures
    // that must stay visible instead of being masked by a successful sandbox
    // teardown.
    await this.deps.disposeStrategySessions?.(sessionId);
    await this.sandboxLifecycle.cleanup(sessionId);
    await this.toolResolver.cleanupSession(sessionId);
  }

  /**
   * Deliver one `user.steer` to the live engine session.
   *
   * Deliberately not a turn, and deliberately not queued: the point of a steer is
   * to reach the turn that is running now, so it takes the same side channel the
   * strategy uses for its own live session. Returns `undefined` when no strategy
   * owns steering for this session — the caller reports that as a refusal, never
   * as a delivery or a buffered later turn.
   */
  async steer(
    session: Session,
    event: Extract<UserEvent, { type: 'user.steer' }>,
  ): Promise<LoopEngineSteerReceipt | undefined> {
    const strategy = this.strategyFor(session);
    if (!hasSteering(strategy)) return undefined;
    const input: LoopEngineSteerInput = {
      inputId: event.input_id,
      text: event.text,
      ...(event.expected_turn_id !== undefined ? { expectedTurnId: event.expected_turn_id } : {}),
    };
    return strategy.steerSession(session.id, input);
  }

  /** MCP connection status for a session (for /v1/x/mcp/status). */
  getMcpStatus(sessionId: string): McpServerStatus[] {
    return this.toolResolver.getMcpStatus(sessionId);
  }

  /**
   * The strategy that owns the engine frozen on this session.
   *
   * Resolved in one place so a turn and a steer cannot reach different engines
   * for the same session — a steer delivered to the default strategy while the
   * turn ran on another engine would be a delivery to nobody.
   */
  private strategyFor(session: Session): AgentStrategy {
    return this.deps.resolveStrategy?.(session.loopEngine ?? 'builtin') ?? this.deps.strategy;
  }
}