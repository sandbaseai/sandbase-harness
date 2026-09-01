import { defineConfig } from 'tsdown';
import { writeFileSync, readFileSync } from 'node:fs';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'mcp/index': 'src/mcp/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: 'node',
    target: 'node22',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { sdk: 'src/sdk/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    platform: 'node',
    target: 'node22',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    onSuccess: async () => {
      const dtsPath = 'dist/sdk.d.ts';
      const content = readFileSync(dtsPath, 'utf-8');
      writeFileSync(dtsPath, `/// <reference types="node" />\n${content}`);
    },
  },
]);
