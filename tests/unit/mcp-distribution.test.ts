import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('MCP OCI distribution', () => {
  it('keeps the registry document aligned with the release version and image', () => {
    const packageManifest = JSON.parse(read('package.json')) as { version: string };
    const server = JSON.parse(read('server.json')) as {
      name: string;
      version: string;
      packages: Array<{ registryType: string; identifier: string; transport: { type: string } }>;
    };

    expect(server.name).toBe('io.github.sandbaseai/sandbase-harness');
    expect(server.version).toBe(packageManifest.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toEqual(expect.objectContaining({
      registryType: 'oci',
      identifier: `ghcr.io/sandbaseai/sandbase-harness-mcp:${packageManifest.version}`,
      transport: { type: 'stdio' },
    }));
  });

  it('publishes release images with package permissions and provenance', () => {
    const workflow = read('.github/workflows/publish-mcp-image.yml');
    const dockerfile = read('Dockerfile.mcp');

    expect(workflow).toContain('types: [published]');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('actions/attest-build-provenance@v4');
    expect(workflow).not.toContain('npm publish');
    expect(dockerfile).toContain('io.modelcontextprotocol.server.name="io.github.sandbaseai/sandbase-harness"');
  });
});
