import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Lint code as if it lived at a given path, with the real root config.
const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

const ruleIds = async (filePath: string, code: string) => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId);
};

describe('package boundaries', () => {
  // The first lint loads the whole config and its plugins: seconds on a cold CI runner.
  beforeAll(() => ruleIds('packages/core/src/fixture.ts', 'export {};'), 60_000);

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
      "import { d } from '@kd-learn/search/port';",
      'export const all = [a, b, c, d];',
    ].join('\n');
    expect(await ruleIds('packages/agent/src/fixture.ts', code)).toEqual([]);
  });

  it.each([
    ["import { x } from '@kd-learn/ai';\nexport const y = x;"],
    ["import { x } from '@kd-learn/storage/sqlite-node';\nexport const y = x;"],
    ["import { x } from '@kd-learn/ai/image';\nexport const y = x;"],
    ["import { x } from '@kd-learn/search/searxng';\nexport const y = x;"],
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
  it.each([
    ["import { readFileSync } from 'node:fs';\nexport const y = readFileSync;"],
    ["import { useState } from 'react';\nexport const y = useState;"],
    ["import { useQuery } from '@tanstack/react-query';\nexport const y = useQuery;"],
    ["import { x } from '@kd-learn/agent';\nexport const y = x;"],
    ["import { x } from '@kd-learn/server';\nexport const y = x;"],
    ["import { x } from '@kd-learn/ui';\nexport const y = x;"],
  ])('api rejects %s', async (code) => {
    expect(await ruleIds('packages/api/src/fixture.ts', code)).toContain('no-restricted-imports');
  });

  it('api accepts core and effect', async () => {
    const code = [
      "import { Schema } from 'effect';",
      "import { a } from '@kd-learn/core';",
      'export const all = [Schema.String, a];',
    ].join('\n');
    expect(await ruleIds('packages/api/src/fixture.ts', code)).toEqual([]);
  });

  it('server accepts Node, core, agent, adapters and the contract', async () => {
    const code = [
      "import { readFileSync } from 'node:fs';",
      "import { a } from '@kd-learn/core';",
      "import { b } from '@kd-learn/agent';",
      "import { c } from '@kd-learn/ai/tanstack';",
      "import { d } from '@kd-learn/api';",
      "import { e } from '@kd-learn/storage/sqlite-node';",
      'export const all = [readFileSync, a, b, c, d, e, process.env];',
    ].join('\n');
    expect(await ruleIds('packages/server/src/fixture.ts', code)).toEqual([]);
  });

  it.each([
    ["import { useState } from 'react';\nexport const y = useState;"],
    ["import { Link } from '@tanstack/react-router';\nexport const y = Link;"],
    ["import { Button } from '@astryxdesign/core';\nexport const y = Button;"],
    ["import { x } from '@kd-learn/ui';\nexport const y = x;"],
    ["import { x } from '@kd-learn/tokens';\nexport const y = x;"],
    ["import { x } from '@kd-learn/web';\nexport const y = x;"],
  ])('server rejects %s', async (code) => {
    expect(await ruleIds('packages/server/src/fixture.ts', code)).toContain(
      'no-restricted-imports',
    );
  });

  it.each([
    ["import { readFileSync } from 'node:fs';\nexport const y = readFileSync;"],
    ["import { x } from '@kd-learn/ai/port';\nexport const y = x;"],
    ["import { x } from '@kd-learn/storage/sqlite-wasm';\nexport const y = x;"],
    ["import { useState } from 'react';\nexport const y = useState;"],
    ['export const y = indexedDB;'],
  ])('storage port stays pure: rejects %s', async (code) => {
    expect(await ruleIds('packages/storage/src/port/fixture.ts', code)).not.toEqual([]);
  });

  it('storage port may import effect and the core domain types', async () => {
    const code = [
      "import { Effect } from 'effect';",
      "import type { DomainEvent } from '@kd-learn/core';",
      'export type All = [Effect.Effect<void>, DomainEvent];',
    ].join('\n');
    expect(await ruleIds('packages/storage/src/port/fixture.ts', code)).toEqual([]);
  });

  it('ai port still imports no other package', async () => {
    const code = "import type { DomainEvent } from '@kd-learn/core';\nexport type E = DomainEvent;";
    expect(await ruleIds('packages/ai/src/port/fixture.ts', code)).toContain(
      'no-restricted-imports',
    );
  });

  it('search port imports no other package and no Node API', async () => {
    const code = "import { readFile } from 'node:fs';\nexport const r = readFile;";
    expect(await ruleIds('packages/search/src/port/fixture.ts', code)).toContain(
      'no-restricted-imports',
    );
  });

  it('storage drivers may use host APIs but not UI', async () => {
    const ok = "import { DatabaseSync } from 'node:sqlite';\nexport const y = DatabaseSync;";
    const bad = "import { useState } from 'react';\nexport const y = useState;";
    expect(await ruleIds('packages/storage/src/sqlite-node/fixture.ts', ok)).toEqual([]);
    expect(await ruleIds('packages/storage/src/sqlite-node/fixture.ts', bad)).toContain(
      'no-restricted-imports',
    );
  });
});
