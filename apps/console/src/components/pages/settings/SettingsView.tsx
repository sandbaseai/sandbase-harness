import type { ConsoleData, ViewId } from '../../../types';
import { RuntimeSettingsEditor } from './RuntimeSettingsEditor';
import { SettingsAdvanced } from './SettingsAdvanced';
import { SettingsApiKeys } from './SettingsApiKeys';
import { SettingsApiReference } from './SettingsApiReference';
import { API_REFERENCE_DOCS } from './apiReferenceDocs';
import { SettingsGeneral } from './SettingsGeneral';
import { SettingsLogs } from './SettingsLogs';
import { SettingsMonitoring } from './SettingsMonitoring';
import { SettingsPage } from './SettingsPage';
import { SettingsWorkspace } from './SettingsWorkspace';
import type { SettingsSection } from './navigation';

export function SettingsView({
  data,
  section,
  onRefresh,
  setView,
}: {
  data: ConsoleData;
  section: SettingsSection;
  onRefresh: () => void;
  setView: (view: ViewId) => void;
}) {
  return (
    <SettingsPage
      data={data}
      section={section}
      setView={setView}
      renderSection={(active) => (
        <>
          {active === 'general' ? <SettingsGeneral data={data} setView={setView} onRefresh={onRefresh} /> : null}
          {active === 'workspace' ? <SettingsWorkspace data={data} /> : null}
          {active === 'advanced' ? <SettingsAdvanced data={data} setView={setView} /> : null}
          {active === 'models' ? <RuntimeSettingsEditor data={data} section="models" onRefresh={onRefresh} /> : null}
          {active === 'loop-engine' ? <RuntimeSettingsEditor data={data} section="loop-engine" onRefresh={onRefresh} /> : null}
          {active === 'storage' ? <RuntimeSettingsEditor data={data} section="storage" onRefresh={onRefresh} /> : null}
          {active === 'memory' ? <RuntimeSettingsEditor data={data} section="memory" onRefresh={onRefresh} /> : null}
          {active === 'sandbox' ? <RuntimeSettingsEditor data={data} section="sandbox" onRefresh={onRefresh} /> : null}
          {active === 'api-keys' ? <SettingsApiKeys data={data} onRefresh={onRefresh} /> : null}
          {active === 'api-reference' ? <SettingsApiReference data={data} docs={API_REFERENCE_DOCS} /> : null}
          {active === 'logs' ? <SettingsLogs data={data} /> : null}
          {active === 'monitoring' ? <SettingsMonitoring data={data} /> : null}
        </>
      )}
    />
  );
}
