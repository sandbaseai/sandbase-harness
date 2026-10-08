// @vitest-environment jsdom
/**
 * Build surfaces' deletion affordances on the published routes:
 *
 * - files archive through `DELETE /v1/files/{id}` — the published file-delete
 *   is archival, so the confirmation names the verb Archive rather than
 *   promising removal;
 * - custom skills delete through `DELETE /v1/skills/{id}` and per-version
 *   through `DELETE /v1/skills/{id}/versions/{vid}`; built-in (`anthropic`)
 *   skills never offer the affordance because the route refuses them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  apiRequests,
  onApiRequest,
  renderConsole,
  resetApi,
  screen,
  userEvent,
  waitFor,
  within,
} from './support/render';
import { Files, Skills } from '../../../apps/console/src/components/pages/BuildPages';
import type { ConsoleData, Skill, WorkspaceFile } from '../../../apps/console/src/types';

const now = '2026-10-05T12:00:00.000Z';

const file: WorkspaceFile = {
  id: 'file_1',
  type: 'file',
  name: 'notes.txt',
  media_type: 'text/plain',
  size_bytes: 42,
  status: 'ready',
  metadata: {},
  created_at: now,
  updated_at: now,
  archived_at: null,
  preview: null,
  preview_truncated: false,
};

const customSkill: Skill = {
  id: 'skill_custom',
  type: 'skill',
  name: 'helper-skill',
  display_title: 'Helper skill',
  description: 'A custom skill',
  compatibility: null,
  source: 'custom',
  latest_version: '20261005',
  versions: [
    { id: 'v_old', created_at: now, latest: false },
    { id: 'v_latest', created_at: now, latest: true },
  ],
  created_at: now,
  updated_at: now,
  file: 'helper-skill/SKILL.md',
};

const builtinSkill: Skill = {
  id: 'skill_builtin',
  type: 'skill',
  name: 'web-search',
  display_title: 'Web search',
  description: 'A built-in skill',
  compatibility: null,
  source: 'anthropic',
  latest_version: '1',
  versions: [{ id: 'v1', created_at: now, latest: true }],
  created_at: now,
  updated_at: now,
  file: null,
};

const data = {
  skills: [customSkill, builtinSkill],
  files: [file],
} as unknown as ConsoleData;

describe('the files page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('archives a file through the delete route after confirmation', async () => {
    const user = userEvent.setup();
    onApiRequest(() => ({ ...file, status: 'archived', archived_at: now }));
    renderConsole(<Files data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('button', { name: /archive file/i }));
    const dialog = await screen.findByRole('dialog', { name: /archive file/i });
    // The sentence leads with the archive verb — DELETE on a file is archival.
    expect((dialog as HTMLElement).textContent).toMatch(/archive\s+notes\.txt/i);
    await user.click(within(dialog).getByRole('button', { name: /archive file/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'DELETE' && item.path === '/v1/files/file_1');
      expect(request).toBeDefined();
    });
  });
});

describe('the skills page', () => {
  beforeEach(resetApi);
  afterEach(resetApi);

  it('deletes a custom skill through the delete route after confirmation', async () => {
    const user = userEvent.setup();
    onApiRequest(() => ({ id: 'skill_custom', type: 'skill_deleted' }));
    renderConsole(<Skills data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('row', { name: /helper skill/i }));
    await user.click(screen.getByRole('button', { name: /delete skill/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete skill/i });
    await user.click(within(dialog).getByRole('button', { name: /delete skill/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'DELETE' && item.path === '/v1/skills/skill_custom');
      expect(request).toBeDefined();
    });
  });

  it('deletes one version through the nested route', async () => {
    const user = userEvent.setup();
    onApiRequest(() => ({}));
    renderConsole(<Skills data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('row', { name: /helper skill/i }));
    await user.click(screen.getAllByRole('button', { name: /delete version/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: /delete version/i });
    await user.click(within(dialog).getByRole('button', { name: /delete version/i }));

    await waitFor(() => {
      const request = apiRequests().find((item) => item.method === 'DELETE' && item.path === '/v1/skills/skill_custom/versions/v_old');
      expect(request).toBeDefined();
    });
  });

  it('offers no delete affordance for a built-in skill', async () => {
    const user = userEvent.setup();
    renderConsole(<Skills data={data} onRefresh={() => {}} />);

    await user.click(screen.getByRole('row', { name: /web search/i }));
    expect(screen.queryByRole('button', { name: /delete skill/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete version/i })).toBeNull();
  });
});
