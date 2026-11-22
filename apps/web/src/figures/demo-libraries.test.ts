// The SRI hashes of the demo libraries (plan hinh-va-demo.md A5, risk 45) match the pinned files
// installed as devDependencies, the same files the CDN serves at those versions.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DemoLibraryId, demoLibraries } from '@kd-learn/core';
import pkg from '../../package.json' with { type: 'json' };

describe('demoLibraries', () => {
  it.each(demoLibraries)('$id: pinned, and its integrity is the installed file', (library) => {
    const devDependencies = pkg.devDependencies as Record<string, string>;
    expect(devDependencies[library.id]).toBe(library.version);
    expect(library.url).toBe(
      `https://cdn.jsdelivr.net/npm/${library.id}@${library.version}/${library.npmPath.slice(library.id.length + 1)}`,
    );
    const file = readFileSync(new URL(`../../node_modules/${library.npmPath}`, import.meta.url));
    expect(`sha384-${createHash('sha384').update(file).digest('base64')}`).toBe(library.integrity);
  });

  it('keeps the schema in step with the list', () => {
    expect([...DemoLibraryId.literals]).toEqual(demoLibraries.map((library) => library.id));
  });
});
