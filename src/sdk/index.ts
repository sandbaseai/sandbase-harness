/// <reference types="node" />
/**
 * managed-agents SDK — public client entry point.
 *
 * Usage:
 *   import { ManagedAgentsClient } from '@sandbaseai/harness/sdk';
 *   const client = new ManagedAgentsClient({ baseUrl: 'http://localhost:3000' });
 *   const session = await client.sessions.create({ agent: 'agent_assistant' });
 *   for await (const ev of client.sessions.chat(session.id, 'hello')) {
 *     if (ev.type === 'agent.message_chunk') process.stdout.write(ev.delta ?? '');
 *   }
 */

export {
  ManagedAgentsClient,
  ManagedAgentsApiError,
  RuntimeSettingsValidationError,
  type ClientOptions,
  type AgentSummary,
  type ApiKeyCreateResponse,
  type ApiKeySummary,
  type EnvironmentSummary,
  type EnvironmentWorkerKeyCreateResponse,
  type EnvironmentWorkerKeySummary,
  type RuntimeMetricsSummary,
  type RuntimeSettingsAdapters,
  type RuntimeSettingsArea,
  type RuntimeSettingsConfig,
  type RuntimeSettingsModel,
  type RuntimeSettingsPatch,
  type RuntimeSettingsSecretStates,
  type RuntimeSettingsState,
  type RuntimeSettingsSummary,
  type RuntimeSettingsValidationCheck,
  type RuntimeSettingsValidationIssue,
  type RuntimeSettingsValidationResult,
  type RuntimeSettingsValidationStatus,
  type SessionArtifactSummary,
  type SessionSummary,
  type StreamedEvent,
  type WorkspaceFileSummary,
} from './client.js';

export {
  collectReply,
  converse,
  followSession,
  inspectSession,
  sessionHistory,
  type CollectedReply,
  type CreateSessionInput,
  type SessionsApi,
} from './session-helpers.js';

export type {
  EnvironmentConfig,
  ExecOptions,
  ExecResult,
  SandboxInstance,
  SandboxProvider,
} from '../types/sandbox.js';
