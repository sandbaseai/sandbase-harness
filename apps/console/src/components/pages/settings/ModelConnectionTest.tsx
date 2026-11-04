import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { postJson } from '../../../api';

type ConnectionResult = {
  ok: boolean;
  outcome: 'ok' | 'configuration_invalid' | 'authentication_failed' | 'model_not_found'
    | 'not_found' | 'timeout' | 'cancelled' | 'rate_limited' | 'network_error' | 'invalid_response' | 'provider_error';
  model: string;
  resolved_model?: string;
  provider: string;
  config_source: 'saved';
  revision: number;
  elapsed_ms: number;
};

/** Probe the input without implicitly saving it or changing runtime activation. */
export function ModelConnectionTest({ model, agentName, revision, disabled, onRefresh }: {
  model: string;
  agentName: string;
  revision: number | undefined;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('settings');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);

  // A response for an old input/revision must never validate the current field.
  useEffect(() => {
    generation.current++;
    setResult(null);
    setFailed(false);
    return () => { generation.current++; };
  }, [model, revision]);

  const test = async () => {
    if (inFlight.current || !revision || !model.trim()) return;
    inFlight.current = true;
    const current = generation.current;
    setBusy(true);
    setResult(null);
    setFailed(false);
    try {
      const response = await postJson<ConnectionResult>('/v1/x/settings/test-model', { model: model.trim(), revision });
      if (current === generation.current) setResult(response);
    } catch {
      if (current === generation.current) setFailed(true);
      onRefresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modelConnectionTest">
      <button className="secondaryButton" type="button"
        aria-label={t('setupModels.connection.testFor', { name: agentName })}
        disabled={disabled || busy || !revision || !model.trim()}
        onClick={() => { void test(); }}>
        {busy ? t('setupModels.connection.testing') : t('setupModels.connection.test')}
      </button>
      <div role="status" aria-live="polite">
        {result ? (
          <div className={`inlineStatus ${result.ok ? 'neutral' : 'error'}`}>
            <span>{t(`setupModels.connection.results.${result.outcome}`)}</span>
            <span>{t('setupModels.connection.context', {
              model: result.resolved_model ?? result.model,
              provider: result.provider, revision: result.revision, ms: result.elapsed_ms,
            })}</span>
          </div>
        ) : null}
        {failed ? <p className="inlineStatus error">{t('setupModels.connection.requestFailed')}</p> : null}
      </div>
    </div>
  );
}
