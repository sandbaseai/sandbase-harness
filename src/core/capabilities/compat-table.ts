/**
 * Renders the CMA capability matrix as the README compatibility table.
 *
 * The README presents three reader-facing states — Supported, Partial,
 * Unsupported — while the matrix records finer distinctions
 * (`unavailable`, `planned`, `not_applicable`, `unverified`). An entry whose
 * matrix status does not survive the three-way mapping names its exact status
 * inside the note so the coarser table never overstates it.
 *
 * `npm run docs:compat` rewrites the table between the
 * `<!-- compat-table:start/end -->` markers in README.md, and the
 * contract-honesty test compares that section against this function's output,
 * so the published table cannot drift from the matrix it claims to summarize.
 */

import type { CapabilityEntry, CapabilityStatus } from './matrix.js';

export const COMPAT_TABLE_START = '<!-- compat-table:start -->';
export const COMPAT_TABLE_END = '<!-- compat-table:end -->';

function displayStatus(status: CapabilityStatus): string {
  if (status === 'supported') return 'Supported';
  if (status === 'partial') return 'Partial';
  return 'Unsupported';
}

function cell(text: string): string {
  // Escape backslashes first: a `\|` written by a later replacement would
  // otherwise be re-read as an escaped pipe when the table is re-parsed.
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function note(entry: CapabilityEntry): string {
  if (entry.status === 'supported') return '';
  const exact = entry.status === 'unavailable' || entry.status === 'partial'
    ? ''
    : `(${entry.status}) `;
  return cell(`${exact}${entry.reason}`);
}

/**
 * The table body that sits between the compat-table markers — header and
 * rows, no markers, no surrounding prose.
 */
export function renderCompatibilityTable(entries: readonly CapabilityEntry[]): string {
  const lines = [
    '| Area | Official capability | Status | Notes |',
    '| --- | --- | --- | --- |',
    ...entries.map(
      (entry) =>
        `| ${cell(entry.area)} | \`${entry.id}\` | ${displayStatus(entry.status)} | ${note(entry)} |`,
    ),
  ];
  return lines.join('\n');
}
