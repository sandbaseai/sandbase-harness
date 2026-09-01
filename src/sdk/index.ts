/// <reference types="node" />
/**
 * managed-agents SDK — public client entry point.
 *
 * Usage:
 *   import { ManagedAgentsClient } from 'managed-agents/sdk';
 *   const client = new ManagedAgentsClient({ baseUrl: 'http://localhost:3000' });
 *   const session = await client.sessions.create({ agent: 'agent_assistant' });
 *   for await (const ev of client.sessions.chat(session.id, 'hello')) {
 *     if (ev.type === 'agent.message_chunk') process.stdout.write(ev.delta ?? '');
 *   }
 */

export {
  ManagedAgentsClient,
  ManagedAgentsApiError,
  type ClientOptions,
  type AgentSummary,
  type ApiKeyCreateResponse,
  type ApiKeySummary,
  type EnvironmentSummary,
  type EnvironmentWorkerKeyCreateResponse,
  type EnvironmentWorkerKeySummary,
  type RuntimeMetricsSummary,
  type RuntimeSettingsPatch,
  type RuntimeSettingsState,
  type RuntimeSettingsSummary,
  type RuntimeSettingsValidationCheck,
  type RuntimeSettingsValidationStatus,
  type SessionArtifactSummary,
  type SessionSummary,
  type StreamedEvent,
  type WorkspaceFileSummary,
} from './client.js';

export type {
  EnvironmentConfig,
  ExecOptions,
  ExecResult,
  SandboxInstance,
  SandboxProvider,
} from '../types/sandbox.js';
