import { X } from 'lucide-react';
import { MetricCard } from '../Common';
import { formatDateShort, relativeDate, shortId } from '../../lib/format';
import type { Environment, Session } from '../../types';
import {
  declaredHostingType,
  effectiveSandboxProvider,
  environmentKeys,
  environmentHostingType,
  environmentMetadataEntries,
  hostingLabel,
} from './EnvironmentPageModel';

export function CloudEnvironment({ environment }: { environment: Environment }) {
  const metadata = environmentMetadataEntries(environment);
  const executionType = environmentHostingType(environment);
  const effectiveProvider = effectiveSandboxProvider(environment);
  const resources = environment.config.resources && typeof environment.config.resources === 'object' && !Array.isArray(environment.config.resources)
    ? environment.config.resources as Record<string, unknown>
    : {};
  return (
    <div className="environmentBody">
      <section className="environmentSection">
        <h2>Execution</h2>
        <p>Sessions created with this environment use this sandbox provider.</p>
        {effectiveProvider === 'local' ? (
          <div className="warningNotice" role="alert">
            <span>Not isolated: tools execute directly on the host machine. Use a Docker, Kubernetes, or self-hosted backend for untrusted agent code.</span>
          </div>
        ) : null}
        <div className="readonlyFields">
          <ReadonlyField label="Hosting type" value={hostingLabel(declaredHostingType(environment))} />
          <ReadonlyField label="Effective backend" value={effectiveProvider} />
          {executionType === 'docker' ? <ReadonlyField label="Docker image" value={String(environment.config.image ?? 'node:22-slim')} /> : null}
          {executionType === 'docker' && resources.memory ? <ReadonlyField label="Memory limit" value={String(resources.memory)} /> : null}
          {executionType === 'docker' && resources.cpu ? <ReadonlyField label="CPU limit" value={String(resources.cpu)} /> : null}
        </div>
      </section>
      <section className="environmentSection">
        <h2>Metadata</h2>
        <p>Add custom key-value pairs to tag and organize this environment. Keys must be lowercase.</p>
        <ReadonlyTable
          empty="No metadata"
          rows={metadata}
          columns={['Key', 'Value']}
        />
      </section>
    </div>
  );
}

export function SelfHostedEnvironment({ environment, sessions }: { environment: Environment; sessions: Session[] }) {
  const keys = environmentKeys(environment);
  const idleSessions = sessions.filter((session) => session.status === 'idle');
  const runningSessions = sessions.filter((session) => session.status === 'running');
  const completedSessions = sessions.filter((session) => session.status === 'terminated');
  const oldestActiveSession = [...idleSessions, ...runningSessions].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return (
    <div className="environmentBody">
      <section className="environmentSection">
        <h2>Overview</h2>
        <p>Live session activity for this self-hosted environment. Updates every few seconds.</p>
        <div className="metricGrid compactMetrics">
          <MetricCard title="Idle sessions" value={idleSessions.length} />
          <MetricCard title="Running sessions" value={runningSessions.length} />
          <MetricCard title="Completed sessions" value={completedSessions.length} />
          <MetricCard title="Oldest active session" value={oldestActiveSession ? relativeDate(oldestActiveSession.created_at) : 'None'} />
        </div>
      </section>
      <div className="selfHostedGrid">
        <section className="environmentSection">
          <h2>Environment keys</h2>
          <p>An environment key lets a runner on your infrastructure connect to this environment and pull jobs. Generate one per host so you can revoke access individually.</p>
          <ReadonlyTable
            empty="No environment keys"
            rows={keys.map((key) => [key.name, shortId(key.id), formatDateShort(key.created_at), formatDateShort(key.expires_at)])}
            columns={['Name', 'ID', 'Created', 'Expires at']}
          />
        </section>
        <section className="setupCard">
          <div className="setupHeader">
            <h2>Set up your self-hosted environment</h2>
            <button className="iconButton quiet" type="button" title="Dismiss setup"><X size={18} /></button>
          </div>
          <p>These instructions guide you through a low-code CLI worker setup. Additional options are also available in public documentation.</p>
          <SetupStep index={1} title="Register an environment key" body="Generate an environment key authenticating your infrastructure with this environment." />
          <SetupStep index={2} title="Export environment key as env var" body="This authorizes the environment worker to pull for work." code={`export MANAGED_AGENTS_ENVIRONMENT_KEY='env-key-...'`} />
          <SetupStep index={3} title="Install managed-agents CLI" body="Run this command on the machine where you want the environment worker to run." code={`npm install -g managed-agents`} />
          <SetupStep index={4} title="Invoke the worker" body="Poll for jobs and execute them locally." code={`managed-agents worker poll \\\n  --environment-id "${environment.id}" \\\n  --workdir "/workspace"`} />
        </section>
      </div>
    </div>
  );
}

export function ReadonlyTable({ columns, rows, empty }: { columns: string[]; rows: string[][]; empty: string }) {
  return (
    <div className="readonlyTable">
      {rows.length === 0 ? <div className="emptyValue">{empty}</div> : (
        <table>
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.join('-')}-${index}`}>
                {row.map((cell, cellIndex) => <td key={`${cell}-${cellIndex}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ReadonlyField({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`readonlyField ${wide ? 'wide' : ''}`}>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function SetupStep({ index, title, body, code }: { index: number; title: string; body: string; code?: string }) {
  return (
    <div className="setupStep">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
        {code ? <pre>{code}</pre> : null}
      </div>
    </div>
  );
}
