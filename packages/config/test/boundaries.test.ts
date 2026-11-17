import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lint code as if it lived at a given path, with the real root config.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

const ruleIds = async (filePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId);
};

describe('package boundaries', () => {
  it.each([
    ["import { readFileSync } from 'node:fs';\nreadFileSync('x');"],
    ["import { readFileSync } from 'fs';\nreadFileSync('x');"],
    ["import { join } from 'path/posix';\njoin('x');"],
    ["import { useState } from 'react';\nuseState(0);"],
    ["import { Link } from '@tanstack/react-router';\nconsole.log(Link);"],
    ["import { x } from '@kd-learn/agent';\nconsole.log(x);"],
  ])('core rejects %s', async (code) => {
    expect(await ruleIds('packages/core/src/fixture.ts', code)).toContain('no-restricted-imports');
  });

  it.each([['document.title;'], ['window.alert(1);'], ["fetch('https://x');"], ['process.env;']])(
    'core rejects host global %s',
    async (code) => {
      expect(await ruleIds('packages/core/src/fixture.ts', code)).toContain(
        'no-restricted-globals',
      );
    },
  );

  it('core accepts effect', async () => {
    const code = "import { Schema } from 'effect';\nexport const S = Schema.String;";
    expect(await ruleIds('packages/core/src/fixture.ts', code)).toEqual([]);
  });

  it('agent accepts core and port entry points', async () => {
    const code = [
      "import { a } from '@kd-learn/core';",
      "import { b } from '@kd-learn/ai/port';",
      "import { c } from '@kd-learn/storage/port';",
      'export const all = [a, b, c];',
    ].join('\n');
    expect(await ruleIds('packages/agent/src/fixture.ts', code)).toEqual([]);
  });

  it.each([
    ["import { x } from '@kd-learn/ai';\nexport const y = x;"],
    ["import { x } from '@kd-learn/storage/sqlite-node';\nexport const y = x;"],
    ["import { x } from '@kd-learn/server';\nexport const y = x;"],
  ])('agent rejects adapters: %s', async (code) => {
    expect(await ruleIds('packages/agent/src/fixture.ts', code)).toContain('no-restricted-imports');
  });

  it('ui rejects server packages', async () => {
    const code = "import { x } from '@kd-learn/server';\nexport const y = x;";
    expect(await ruleIds('packages/ui/components/Fixture.tsx', code)).toContain(
      'no-restricted-imports',
    );
  });

  it('ai allows TanStack AI but not other TanStack libraries', async () => {
    const ok = "import { chat } from '@tanstack/ai';\nexport const y = chat;";
    const bad = "import { useQuery } from '@tanstack/react-query';\nexport const y = useQuery;";
    expect(await ruleIds('packages/ai/src/fixture.ts', ok)).toEqual([]);
    expect(await ruleIds('packages/ai/src/fixture.ts', bad)).toContain('no-restricted-imports');
  });
});
