import { nanoid } from 'nanoid';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { Session, SessionLoopEngine } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import { ModelRegistry, modelEndpointHost } from '@/model/registry.js';
import { InMemoryEventLog } from './in-memory-event-log.js';
import {
  clearCredentialInjectionBundle,
  createCredentialRedactor,
} from '@/core/credentials/redaction.js';
import {
  placeholderToEgressSubstitution,
  type CredentialInjectionBundle,
  type CredentialInjectionTarget,
} from '@/core/credentials/injection.js';
import type { SandboxCredentials } from './tool-resolver.js';
import {
  assertPiAgentCanExecute,
} from '@/core/session/pi-policy.js';
import {
  validateDelegation,
  childDelegationContext,
  DelegationError,
  type DelegationContext,
} from '@/core/orchestrator/agent-orchestrator.js';

export interface DelegationServiceDeps {
  agents: AgentDefinition[];
  modelRegistry: ModelRegistry;
  strategy: AgentStrategy;
  /** Resolve the parent's frozen engine for delegated turns as well. */
  resolveStrategy?: (loopEngine: SessionLoopEngine) => AgentStrategy;
  /**
   * Provision a sandbox for a sub-agent run.
   *
   * Takes the parent session so the sub-agent lands on the same backend the
   * parent resolved to. A sub-agent executing shell commands is not a weaker
   * operation than the parent doing it, so it must not get a weaker sandbox:
   * previously this hardcoded the local provider, which meant a session
   * configured for Docker or Kubernetes still ran delegated commands directly
   * on the runtime host.
   */
  provisionSandbox: (session: Session, sandboxId: string) => Promise<SandboxInstance>;
  composeSystemPrompt: (agent: AgentDefinition) => string;
  buildMemoryContext?: (session: Session, agent: AgentDefinition, event: UserEvent) => Promise<string>;
  buildSandboxTools: (agent: AgentDefinition, sandbox: SandboxInstance, session?: Session, credentials?: SandboxCredentials) => Record<string, any>;
  /**
   * Resolve vault credentials for a delegated child.
   *
   * Called with the child's synthetic session id and the parent session's
   * `vaultIds` in the target, because the child row is never persisted: the
   * override is what carries the parent's vault scope into the resolution,
   * and it can only name what the parent itself references.
   */
  resolveCredentialInjections?: (sessionId: string, target?: CredentialInjectionTarget) => CredentialInjectionBundle;
  resolveSkillDirs?: (agent: AgentDefinition) => string[];}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  buildDelegationTools(
    agent: AgentDefinition,
    ctx: DelegationContext,
    session: Session,
  ): Record<string, any> {
    const tools: Record<string, any> = {};
    const loadedNames = this.deps.agents.map((loaded) => loaded.name);
    const allowed = agent.delegations ?? [];

    for (const target of allowed) {
      tools[`delegate_to_${target}`] = {
        description: `Delegate a self-contained task to the "${target}" agent and get its result.`,
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: `Task/question for the ${target} agent` },
          },
          required: ['task'],
        },
        execute: async ({ task }: { task: string }) => {
          try {
            validateDelegation({
              fromAgent: agent.name,
              toAgent: target,
              chain: ctx.chain,
              depth: ctx.depth,
              maxDepth: ctx.maxDepth,
              allowedTargets: allowed,
              loadedAgentNames: loadedNames,
            });
            return await this.runSubAgent(target, task, childDelegationContext(ctx, target), session);
          } catch (err) {
            if (err instanceof DelegationError) return `Delegation error: ${err.message}`;
            return `Delegation failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      };
    }

    if (agent.enable_general_subagent) {
      tools['general_subagent'] = {
        description: 'Spawn a temporary sub-agent to handle a self-contained sub-task and return its result. The sub-agent cannot delegate further.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The sub-task to perform' },
          },
          required: ['task'],
        },
        execute: async ({ task }: { task: string }) => {
          if (ctx.depth >= ctx.maxDepth) {
            return `Delegation error: max depth (${ctx.maxDepth}) reached`;
          }
          try {
            const childAgent: AgentDefinition = {
              ...agent,
              delegations: [],
              enable_general_subagent: false,
            };
            return await this.runSubAgentWithDefinition(
              childAgent,
              task,
              childDelegationContext(ctx, `${agent.name}#sub`),
              session,
            );
          } catch (err) {
            return `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      };
    }

    return tools;
  }

  private async runSubAgent(
    targetName: string,
    task: string,
    ctx: DelegationContext,
    session: Session,
  ): Promise<string> {
    const target = this.deps.agents.find((agent) => agent.name === targetName);
    if (!target) return `Delegation error: agent "${targetName}" not found`;
    return this.runSubAgentWithDefinition(target, task, ctx, session);
  }

  private async runSubAgentWithDefinition(
    target: AgentDefinition,
    task: string,
    ctx: DelegationContext,
    session: Session,
  ): Promise<string> {
    const strategy = this.deps.resolveStrategy?.(session.loopEngine ?? 'builtin') ?? this.deps.strategy;
    // A delegated target is a new Pi execution boundary. Validate its policy
    // before resolving credentials, constructing a model, or provisioning a
    // sandbox; otherwise a parent Pi session could bypass the creation-time
    // never_allow/disabled admission gate for its child. A target declaring
    // `always_ask` is admitted, and the gate its plan names is what decides the
    // call before it executes.
    if (session.loopEngine === 'pi' || strategy.name === 'pi') {
      assertPiAgentCanExecute(target);
    }
    // Pi owns its transport but still needs the selected concrete model config.
    // Builtin strategies keep their existing AI SDK model construction path and
    // do not need registry resolution before that factory runs.
    const subSessionId = `subsess_${ctx.chain.join('.')}_${nanoid(8)}`;
    const childSession: Session = {
      id: subSessionId,
      agentId: target.name,
      agentName: target.name,
      agentDefinition: target,
      loopEngine: session.loopEngine ?? 'builtin',
      environmentId: session.environmentId,
      resources: session.resources,
      contextId: session.contextId,
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Session;
    // Same backend as the parent session, resolved through the same fail-loud
    // path — a sub-agent must not receive weaker isolation than its parent.
    const sandbox = await this.deps.provisionSandbox(session, subSessionId);
    // The child inherits exactly the vaults the parent session references —
    // `session.vaultIds` is the hydrated row value, and an absent list narrows
    // the child to none rather than widening it to anything the store holds.
    // Placeholders go to the child's own sandbox boundary, provisioned above,
    // so the secret still never enters a delegated process environment — and
    // a child sandbox with no boundary has its environment credentials
    // refused, never materialized as plaintext.
    const usePlaceholders = typeof sandbox.configureEgressSubstitutions === 'function';
    const childCredentialTarget = (): CredentialInjectionTarget => ({
      vaultIds: session.vaultIds ?? [],
      placeholders: usePlaceholders,
    });
    const resolvedCredentials = this.deps.resolveCredentialInjections?.(childSession.id, childCredentialTarget());
    if (resolvedCredentials && resolvedCredentials.placeholders.length > 0) {
      sandbox.configureEgressSubstitutions!(resolvedCredentials.placeholders.map(placeholderToEgressSubstitution));
    }
    const credentials: SandboxCredentials | undefined = resolvedCredentials
      ? { env: { ...resolvedCredentials.environment }, redactor: createCredentialRedactor(resolvedCredentials) }
      : undefined;

    const modelConfig = strategy.requiresModel === false
      ? this.deps.modelRegistry.resolveModelConfig(target.model)
      : undefined;
    const model = strategy.requiresModel === false
      ? undefined
      : this.deps.modelRegistry.createModel(target.model, {
          headers: this.modelRequestHeaders(childSession, target, childCredentialTarget()),
        });

    try {
      const tools = this.deps.buildSandboxTools(target, sandbox, childSession, credentials);
      Object.assign(tools, this.buildDelegationTools(target, ctx, session));

      const memLog = new InMemoryEventLog();
      const collected: string[] = [];

      const subContext: StrategyContext = {
        session: childSession,
        systemPrompt: this.deps.buildMemoryContext
          ? await this.deps.buildMemoryContext(childSession, target, { type: 'user.message', content: [{ type: 'text', text: task }] })
          : this.deps.composeSystemPrompt(target),
        userEvent: { type: 'user.message', content: [{ type: 'text', text: task }] },
        messages: [{ role: 'user', content: [{ type: 'text', text: task }] }] as any,
        modelConfig,
        model,
        skillDirs: this.deps.resolveSkillDirs?.(target) ?? [],
        tools,
        sandbox,
        eventLog: memLog,
        broadcast: (event) => {
          if (event.type === 'agent.message' && event.content) {
            const text = event.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join('\n');
            if (text) collected.push(text);
          }
        },
        config: {
          maxSteps: target.max_turns ?? 25,
          temperature: target.temperature ?? 0.7,
        },
      };

      for await (const _evt of strategy.execute(subContext)) {
        // sub-agent events are ephemeral
      }

      return collected.join('\n') || '(sub-agent produced no output)';
    } finally {
      // Same lifetime rule as a root turn: the run's end retires the redactor
      // and the bundle it was built from. The placeholders on the child's own
      // boundary die with the sandbox, cleaned up below.
      credentials?.redactor.clear();
      clearCredentialInjectionBundle(resolvedCredentials);
      await sandbox.cleanup().catch(() => {});
    }
  }

  /**
   * Vault credentials a delegated child's model request may carry.
   *
   * Same rule as the root executor's model injection: the credential policy
   * is asked with the host the resolved endpoint names, the child borrows the
   * parent's vault ids, and real header values stay inside the runtime
   * process — the model client is runtime-side, not sandbox-side.
   */
  private modelRequestHeaders(
    childSession: Session,
    agent: AgentDefinition,
    target: CredentialInjectionTarget,
  ): Record<string, string> | undefined {
    const resolve = this.deps.resolveCredentialInjections;
    if (!resolve) return undefined;
    let host: string | undefined;
    try {
      host = modelEndpointHost(this.deps.modelRegistry.resolveModelConfig(agent.model));
    } catch {
      host = undefined;
    }
    // Only the request_headers channel is consumed here, so no placeholders:
    // the environment channel is unused by the model client, and an env-scope
    // credential admitted under the placeholder rule would mint a token no
    // boundary ever registers.
    const bundle = resolve(childSession.id, { vaultIds: target.vaultIds, targetHost: host });
    const headers = Object.keys(bundle.request_headers).length > 0
      ? { ...bundle.request_headers }
      : undefined;
    clearCredentialInjectionBundle(bundle);
    return headers;
  }
}
