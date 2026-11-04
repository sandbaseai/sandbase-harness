import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const patch = parse(readFileSync('examples/deepseek-harness/cordis.yml', 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
}) as Array<{ insert: Array<{ config: { command: string; args: string[] } }> }>;
const config = patch[0]!.insert[0]!.config;

// DSH evaluates !!js against its launcher-provided context before spawning MCP.
// Run the shipped expression, with a decoy web profile to catch cross-profile reads.
describe('DSH MCP entry follows the active profile', () => {
  it.each(['web', 'desktop', 'custom-profile'])('uses the %s profile on POSIX', (name) => {
    const dir = `/tmp/dsh test/profiles/${name}`;
    const entry = runInNewContext(config.args[0]!, {
      profileContext: { name, dir },
      dshHomePath: (path: string) => posix.join('/tmp/dsh test', path),
    }) as string;
    expect(config.command).toBe('node');
    expect(config.args).toHaveLength(1);
    expect(entry).toBe(posix.join(dir, 'node_modules/managed-agents/dist/mcp/index.js'));
  });

  it('preserves a Windows application-owned profile with spaces', () => {
    const dir = 'C:\\DSH Test\\application profile';
    const entry = runInNewContext(config.args[0]!, {
      profileContext: { name: 'desktop', dir },
      dshHomePath: (path: string) => win32.join('C:\\DSH Test', path),
    }) as string;
    expect(win32.normalize(entry)).toBe(win32.join(dir, 'node_modules/managed-agents/dist/mcp/index.js'));
  });
});
