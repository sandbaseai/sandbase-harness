import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { safeMarkdownUrl } from '../../apps/console/src/lib/markdown.js';

const css = readFileSync('apps/console/src/styles.css', 'utf8');
// The markdown pipeline lives with the event render table since the
// eventRenderers split — the contract is unchanged, only the file moved.
const sessionPage = readFileSync('apps/console/src/components/session/eventRenderers.tsx', 'utf8');

describe('Console Markdown contracts', () => {
  it('allows web and mail links while rejecting executable URL schemes', () => {
    expect(safeMarkdownUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(safeMarkdownUrl('mailto:test@example.com')).toBe('mailto:test@example.com');
    expect(safeMarkdownUrl('/dashboard/')).toBe('/dashboard/');
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(safeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('keeps assistant code blocks readable and copyable in the light conversation surface', () => {
    expect(sessionPage).toContain('skipHtml');
    expect(sessionPage).toContain('urlTransform={safeMarkdownUrl}');
    expect(sessionPage).toContain('components={{ code: MarkdownCode, pre: MarkdownPre, a: MarkdownLink }}');
    expect(sessionPage).toContain('Copy code');
    expect(css).toMatch(/\.markdownCodeBlock\s*\{[^}]*background:\s*var\(--surface\)/s);
    expect(css).toMatch(/\.markdownCodeBlock pre\s*\{[^}]*background:\s*transparent/s);
    expect(css).not.toMatch(/\.conversationBubble pre\s*\{[^}]*color:\s*#e6edf7/s);
  });
});
