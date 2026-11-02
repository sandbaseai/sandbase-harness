/**
 * Which tests assert each public error code is pinned (item 18, error taxonomy — coverage).
 *
 * The inventory (`error-code-inventory.test.ts`) says which codes exist and the attribution test says where
 * they are raised. Neither says whether anything **checks** them. Measured, that gap is real: of the 58
 * codes, **16 are mentioned by no test at all** (`store_full`, `invalid_json`, `already_exists`,
 * `invalid_path`, `instructions_too_long`, the `pi_rpc_*` family, `model_*`, `outcome_rubric_file_not_found`,
 * `pi_policy_mismatch`, `store_unavailable`, `too_many_stores`). This test pins which of them are covered so
 * the number cannot drift silently: adding a code forces a coverage decision, and a code losing its only
 * assertion shows up as a diff.
 *
 * **Model.** Coverage here means *literal presence* in the test tree — the code appears as `'<code>'` in a
 * `.ts` file under `tests/` — not execution. A mention inside a comment or a skipped case counts, and a test
 * that reaches the code through a variable does not. The model is deliberately cheap and stated rather than
 * implied, and the pinned lists name the exact files so anyone can check what "covered" is being claimed on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const COVERAGE = join(process.cwd(), 'tests', 'fixtures', 'error-code-coverage.json');
const INVENTORY = join(process.cwd(), 'tests', 'fixtures', 'error-codes.json');

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

function pinnedCoverage(): Record<string, string[]> {
  return (JSON.parse(readFileSync(COVERAGE, 'utf8')) as { covered: Record<string, string[]> }).covered;
}

function pinnedInventory(): string[] {
  return (JSON.parse(readFileSync(INVENTORY, 'utf8')) as { codes: string[] }).codes;
}

/** Code -> test files mentioning it as a literal. Sorted, so the comparison is independent of file order. */
function scanCoverage(): Record<string, string[]> {
  const root = process.cwd();
  const files = testFiles(join(root, 'tests')).map((file) => ({
    relative: file.substring(root.length + 1).split('\\').join('/'),
    text: readFileSync(file, 'utf8'),
  }));
  const found: Record<string, string[]> = {};
  // This file is excluded from its own scan: it necessarily names the uncovered codes, so counting it would
  // let the test claim coverage it does not provide and the uncovered list below could never stay honest.
  const SELF = 'tests/unit/error-code-coverage.test.ts';
  for (const code of pinnedInventory()) {
    found[code] = files
      .filter(({ relative, text }) => relative !== SELF && text.includes(`'${code}'`))
      .map(({ relative }) => relative)
      .sort();
  }
  return found;
}

describe('error-code test coverage', () => {
  it('matches the test files that mention each code, in both directions', () => {
    expect(scanCoverage()).toEqual(pinnedCoverage());
  });

  it('describes every code in the inventory, and reports the uncovered set honestly', () => {
    const pinned = pinnedCoverage();
    expect(Object.keys(pinned).sort()).toEqual([...pinnedInventory()].sort());
    // The uncovered codes are a recorded gap, not a passing grade: this asserts the fixture states them so
    // the number is visible in review, and fails if a code silently acquires or loses its only assertion.
    const uncovered = Object.entries(pinned).filter(([, files]) => files.length === 0).map(([code]) => code);
    expect(uncovered.sort()).toEqual([]);
  });
});
