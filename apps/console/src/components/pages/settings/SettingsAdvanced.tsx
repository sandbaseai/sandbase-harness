import { Code2, FileText, Gauge, Shield } from 'lucide-react';
import { KeyValuePanel } from '../../Common';
import type { ConsoleData, ViewId } from '../../../types';

export function SettingsAdvanced({ data, setView }: { data: ConsoleData; setView: (view: ViewId) => void }) {
  const settings = data.settings;
  return (
    <section className="stack">
      <div className="pageIntro">
        <div>
          <h1>Advanced</h1>
          <p>Runtime internals live here so the default setup stays focused on building agents.</p>
        </div>
      </div>
      <div className="advancedSettingsGrid">
        <div className="panel subtlePanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><Gauge size={18} /></span>
            <div>
              <h2>Runtime defaults</h2>
              <p>Managed Agents ships with local defaults that are enough for a first run.</p>
            </div>
          </div>
          <KeyValuePanel rows={[
            ['Loop engine', settings?.saved_config.loop_engine.provider ?? 'builtin'],
            ['Metadata storage', settings?.saved_config.storage.metadata.provider ?? 'sqlite'],
            ['Artifact storage', settings?.saved_config.storage.artifacts.provider ?? 'local'],
            ['Memory backend', settings?.saved_config.memory.enabled ? settings.saved_config.memory.provider : 'off'],
            ['Sandbox', settings?.saved_config.sandbox.provider ?? data.runtime?.sandbox_providers[0] ?? 'local'],
          ]} />
        </div>
        <div className="panel subtlePanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><Shield size={18} /></span>
            <div>
              <h2>Operational views</h2>
              <p>Use these when debugging the local runtime. They are not required to create an agent.</p>
            </div>
          </div>
          <div className="settingsLinkList">
            <button type="button" onClick={() => setView('logs')}>Runtime logs</button>
            <button type="button" onClick={() => setView('monitoring')}>Monitoring</button>
            <button type="button" onClick={() => setView('outcomes')}>Outcome templates (local)</button>
          </div>
        </div>
        <div className="panel subtlePanel advancedJsonPanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><Code2 size={18} /></span>
            <div>
              <h2>Runtime configuration</h2>
              <p>Most builders should not need this. Edit specific runtime areas only when you are wiring another engine, storage backend, memory provider, or sandbox.</p>
            </div>
          </div>
          <div className="settingsLinkList">
            <button type="button" onClick={() => setView('models')}>Model provider editor</button>
            <button type="button" onClick={() => setView('loop-engine')}>Loop engine editor</button>
            <button type="button" onClick={() => setView('storage')}>Storage editor</button>
            <button type="button" onClick={() => setView('memory')}>Memory editor</button>
            <button type="button" onClick={() => setView('sandbox')}>Sandbox editor</button>
          </div>
        </div>
        <div className="panel subtlePanel">
          <div className="builderSetupHeader compact">
            <span className="softIcon"><FileText size={18} /></span>
            <div>
              <h2>Developer reference</h2>
              <p>Keep API details one click away, but outside the first-run path.</p>
            </div>
          </div>
          <button className="secondaryButton fitButton" type="button" onClick={() => setView('api-reference')}>Open API reference</button>
        </div>
      </div>
    </section>
  );
}
