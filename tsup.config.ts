import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // CLI entry (needs the shebang)
    entry: { index: 'src/index.ts', 'mcp/index': 'src/mcp/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: 'node',
    target: 'node22',
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // SDK entry (library import, no shebang)
    entry: { sdk: 'src/sdk/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    platform: 'node',
    target: 'node22',
    splitting: false,
  },
]);
