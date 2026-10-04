import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { copyText } from '../lib/format';
import {
  EQUIVALENT_LANGUAGES,
  equivalentSnippet,
  type EquivalentLanguage,
  type EquivalentRequest,
} from '../lib/equivalentRequest';

/**
 * Live "make this call yourself" preview for a create form. `request` is the
 * descriptor of the HTTP call the form's submit would send; it is rebuilt on
 * every render, so the snippets track the fields the operator is editing.
 */
export function EquivalentRequestPanel({ request }: { request: EquivalentRequest | null }) {
  const [language, setLanguage] = useState<EquivalentLanguage>('typescript');
  const baseUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const snippet = useMemo(
    () => (request ? equivalentSnippet(request, baseUrl, language) : ''),
    [request, baseUrl, language],
  );

  return (
    <section className="composerSection equivalentRequest" aria-label="Equivalent request">
      <div className="snippetHeader">
        <h2>Equivalent request</h2>
        <div className="equivalentRequestTabs" role="tablist">
          {EQUIVALENT_LANGUAGES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={language === item.id}
              className={`equivalentRequestTab ${language === item.id ? 'selected' : ''}`}
              onClick={() => setLanguage(item.id)}
            >
              {item.label}
            </button>
          ))}
          <button
            className="iconButton"
            type="button"
            title="Copy snippet"
            aria-label="Copy snippet"
            disabled={!request}
            onClick={() => copyText(snippet)}
          >
            <Copy size={14} />
          </button>
        </div>
      </div>
      {request ? (
        <pre className="metricsPreview apiSnippet">{snippet}</pre>
      ) : (
        <p className="apiEmptyState">Fix the config errors above to preview the request.</p>
      )}
    </section>
  );
}
