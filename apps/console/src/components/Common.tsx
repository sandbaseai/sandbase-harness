import { ReactNode } from 'react';
import { RefreshCw, Search } from 'lucide-react';

export function Toolbar({ query, onQuery, placeholder, actions }: { query: string; onQuery: (value: string) => void; placeholder: string; actions: ReactNode }) {
  return (
    <div className="toolbar">
      <div className="searchBox">
        <Search size={17} />
        <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={placeholder} />
      </div>
      <div className="toolbarActions">{actions}</div>
    </div>
  );
}

export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="filterSelect">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function SummaryStrip({ items }: { items: Array<{ label: string; value: ReactNode; icon: ReactNode }> }) {
  return (
    <div className="summaryStrip">
      {items.map((item) => (
        <div className="summaryItem" key={item.label}>
          <span>{item.icon}</span>
          <div>
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}

export function KeyValuePanel({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className="tablePanel kv">
      {rows.map(([key, value]) => (
        <div className="kvRow" key={key}>
          <span>{key}</span>
          <strong>{value || 'not configured'}</strong>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="emptyState">
      {icon}
      <strong>{title}</strong>
      {body ? <span>{body}</span> : null}
      {action ? <div className="emptyStateAction">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label }: { label?: string } = {}) {
  return <div className="loading"><RefreshCw size={18} />{label ?? 'Loading console'}</div>;
}

export function StatusPill({ status }: { status: string }) {
  const label = status === 'requires_action' || status === 'awaiting_action'
    ? 'Needs approval'
    : status === 'rescheduling' ? 'Retrying' : status;
  return <span className={`status ${status}`}>{label}</span>;
}

export function RequiredMark() {
  return <span className="requiredMark">*</span>;
}

export function ResourceBadge({ icon, label, children }: { icon?: ReactNode; label?: ReactNode; children?: ReactNode }) {
  return (
    <span className="resourceBadge">
      {icon ? icon : null}
      <span>{label ?? children}</span>
    </span>
  );
}

export function MetricCard({ title, value, subtitle }: { title: string; value: ReactNode; subtitle?: string }) {
  return (
    <div className="metricCard">
      <strong>{title}</strong>
      <span>{value}</span>
      {subtitle ? <small>{subtitle}</small> : null}
    </div>
  );
}
