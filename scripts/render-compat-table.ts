/**
 * Regenerates the CMA compatibility table inside README.md and
 * README.zh-CN.md from `src/core/capabilities/matrix.ts`. Run with
 * `npm run docs:compat`.
 *
 * The table lives between the compat-table markers; everything outside them is
 * left byte-identical. The contract-honesty test asserts the same equality,
 * so editing the table by hand fails CI rather than silently drifting.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMPAT_TABLE_END,
  COMPAT_TABLE_START,
  renderCompatibilityTable,
} from '../src/core/capabilities/compat-table.js';
import { CMA_CAPABILITY_MATRIX } from '../src/core/capabilities/matrix.js';

const README_FILES = ['README.md', 'README.zh-CN.md'];

const table = renderCompatibilityTable(CMA_CAPABILITY_MATRIX);

for (const name of README_FILES) {
  const path = resolve(process.cwd(), name);
  const readme = readFileSync(path, 'utf8');
  const start = readme.indexOf(COMPAT_TABLE_START);
  const end = readme.indexOf(COMPAT_TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${name} is missing a usable ${COMPAT_TABLE_START} … ${COMPAT_TABLE_END} block`);
  }
  const next =
    readme.slice(0, start + COMPAT_TABLE_START.length) +
    '\n' +
    table +
    '\n' +
    readme.slice(end);
  if (next === readme) {
    console.log(`${name} compatibility table is already up to date.`);
  } else {
    writeFileSync(path, next);
    console.log(`${name} compatibility table regenerated: ${CMA_CAPABILITY_MATRIX.length} entries.`);
  }
}
