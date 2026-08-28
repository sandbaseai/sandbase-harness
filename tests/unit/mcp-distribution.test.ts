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
    expect(workflow).toContain('artifact-metadata: write');
    expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(workflow).toContain('actions/attest-build-provenance@v4');
    expect(workflow).not.toContain('npm publish');
    expect(dockerfile).toContain('io.modelcontextprotocol.server.name="io.github.sandbaseai/sandbase-harness"');
  });

  it('publishes validated metadata through short-lived GitHub OIDC', () => {
    const workflow = read('.github/workflows/publish-mcp-registry.yml');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('docker manifest inspect');
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).toContain('./mcp-publisher validate');
    expect(workflow).toContain('./mcp-publisher login github-oidc');
    expect(workflow).toContain('./mcp-publisher publish');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('MCP_GITHUB_TOKEN');
  });

  it('builds missing dist entries during git-hosted installs', () => {
    const packageManifest = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      bin: Record<string, string>;
    };
    const prepare = read('scripts/prepare-install.mjs');

    expect(packageManifest.scripts.prepare).toBe('node scripts/prepare-install.mjs');
    expect(packageManifest.bin['managed-agents']).toBe('dist/index.js');
    expect(packageManifest.bin['managed-agents-mcp']).toBe('dist/mcp/index.js');
    expect(prepare).toContain("join(root, 'dist', 'index.js')");
    expect(prepare).toContain("join(root, 'dist', 'mcp', 'index.js')");
    expect(prepare).toContain("['run', 'build']");
    expect(prepare).toContain('process.exit(0)');
  });

  it('keeps DSH MCP environment values valid when optional variables are unset', () => {
    const patch = read('examples/deepseek-harness/cordis.yml');

    expect(patch).toContain('command: node');
    expect(patch).toContain("dshHomePath('profiles/web/node_modules/managed-agents/dist/mcp/index.js')");
    expect(patch).toContain("process.env.MANAGED_AGENTS_URL ?? 'http://127.0.0.1:3000'");
    expect(patch).toContain("process.env.MANAGED_AGENTS_API_KEY ?? ''");
    expect(patch).not.toContain('MANAGED_AGENTS_API_KEY: !!js process.env.MANAGED_AGENTS_API_KEY\n');
  });

  it('ships a portable Agent Plugin pinned to the release MCP image', () => {
    const packageManifest = JSON.parse(read('package.json')) as { version: string };
    const plugin = JSON.parse(read('agent-plugin/plugin.json')) as {
      $schema: string;
      name: string;
      version: string;
      license: string;
    };
    const mcp = JSON.parse(read('agent-plugin/mcp.json')) as {
      $schema: string;
      mcpServers: Record<string, {
        type: string;
        command: string;
        args: string[];
        env?: Record<string, string>;
      }>;
    };
    const server = mcp.mcpServers['sandbase-harness'];

    expect(plugin).toEqual(expect.objectContaining({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'sandbase-harness',
      version: '0.1.0',
      license: 'Apache-2.0',
    }));
    expect(mcp.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    expect(server).toEqual(expect.objectContaining({
      type: 'stdio',
      command: 'docker',
    }));
    expect(server.args).toContain(`ghcr.io/sandbaseai/sandbase-harness-mcp:${packageManifest.version}`);
    expect(server.args).toContain('MANAGED_AGENTS_URL');
    expect(server.args).toContain('MANAGED_AGENTS_API_KEY');
    expect(server.env).toBeUndefined();
    expect(JSON.stringify(mcp)).not.toMatch(/api[_-]?key["']?\s*:/i);
  });
});
