import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('v1 local-first architecture spec', () => {
  it('is the first spec reading item and defines the v1 runtime shape', () => {
    const specIndex = read('docs/spec/README.md');
    const spec = read('docs/spec/v1-local-first-architecture.md');

    expect(specIndex).toContain('v1-local-first-architecture.md');
    expect(specIndex.indexOf('v1-local-first-architecture.md')).toBeLessThan(specIndex.indexOf('requirements.md'));
    expect(spec).toContain('Runtime metadata in SQLite');
    expect(spec).toContain('Uploaded files, skills, and session artifacts on the local filesystem');
    expect(spec).toContain('One active model provider boundary');
    expect(spec).toContain('One built-in loop engine: `managed-agents`');
    expect(spec).toContain('One context memory backend by default: SQLite');
    expect(spec).toContain('One sandbox backend by default: local');
  });

  it('keeps public docs on settings rather than provider marketplace flows', () => {
    const readme = read('README.md');
    const docsIndex = read('docs/README.md');
    const apiMatrix = read('docs/api-matrix.md');
    const extendedRoutes = read('src/api/routes/extended.ts');
    const runtimeEntry = read('src/index.ts');
    const settingsPage = read('apps/console/src/components/pages/settings/SettingsPage.tsx');

    expect(readme).toContain('SQLite metadata');
    expect(readme).toContain('local file/skill');
    expect(readme).toContain('One active model provider boundary');
    expect(readme).toContain('"hosting_type": "local"');
    expect(readme).toContain('"sandbox_provider": "local"');
    expect(readme).not.toContain('"name": "Default cloud"');
    expect(readme).not.toContain('Local, Docker, and self-hosted sandbox provider support');
    expect(readme).not.toContain('OpenAI-compatible, Ollama-compatible, and Anthropic model adapters');
    expect(readme.indexOf("import { ManagedAgentsClient } from 'managed-agents/sdk'"))
      .toBeLessThan(readme.indexOf("import Anthropic from '@anthropic-ai/sdk'"));

    expect(docsIndex).toContain('## Advanced / Optional');
    expect(docsIndex.indexOf('## Advanced / Optional')).toBeLessThan(docsIndex.indexOf('[Deployment Examples]'));
    expect(docsIndex).not.toContain('[Sandbox Providers]');

    expect(apiMatrix).toContain('| Runtime settings | `/v1/x/settings` | Supported |');
    expect(apiMatrix).toContain('| Worker queue | `/v1/x/worker/claim`, `/v1/x/worker/complete` | Advanced |');
    expect(apiMatrix).not.toContain('| Model providers | `/v1/x/model-providers` |');
    expect(apiMatrix).not.toContain('| Memory providers | `/v1/x/memory-providers` |');
    expect(apiMatrix).not.toContain('| Storage providers | `/v1/x/storage-providers` |');
    expect(apiMatrix).toContain('Historical provider CRUD endpoints');
    expect(apiMatrix).toContain('removed from the v1 public surface');

    expect(extendedRoutes).not.toContain("'/model-providers'");
    expect(extendedRoutes).not.toContain("'/memory-providers'");
    expect(extendedRoutes).not.toContain("'/storage-providers'");

    expect(runtimeEntry).toContain('configure the active model provider boundary');
    expect(runtimeEntry).not.toContain('add a model provider');
    expect(runtimeEntry).toContain("mkdirSync(join(cwd, 'agents')");
    expect(runtimeEntry).toContain("mkdirSync(join(cwd, 'skills')");
    expect(runtimeEntry).toContain('skill_example-skill');
    expect(runtimeEntry).toContain('sandbox_provider: local');

    expect(settingsPage).toContain('\\"hosting_type\\":\\"local\\"');
    expect(settingsPage).toContain('\\"sandbox_provider\\":\\"local\\"');
    expect(settingsPage).not.toContain('\\"hosting_type\\":\\"self_hosted\\"');
  });

  it('documents the companion DSH Skill install path from GitHub source', () => {
    const command = 'npx --yes github:sandbaseai/sandbase-skills add multi-source-search';
    const destination = '.dsh/skills/multi-source-search';

    expect(read('README.md')).toContain(command);
    expect(read('README.md')).toContain(destination);
    expect(read('examples/deepseek-harness/README.md')).toContain(command);
    expect(read('examples/deepseek-harness/README.md')).toContain(destination);
  });

  it('offers a Chinese entry point with the verified source and DSH paths', () => {
    const root = read('README.md');
    const chinese = read('README.zh-CN.md');

    expect(root).toContain('[中文](./README.zh-CN.md)');
    expect(chinese).toContain('git clone --branch v0.3.2 --depth 1');
    expect(chinese).toContain('dsh plugin --profile web add managed-agents');
    expect(chinese).toContain('npx --yes github:sandbaseai/sandbase-skills add multi-source-search');
    expect(chinese).toContain('.dsh/skills/multi-source-search');
    expect(chinese).not.toMatch(/(?:^|\n)npx managed-agents/m);
  });
});
