// Fails when the SSR build (`.output/server`) contains the browser-only SQLite driver.
// The driver must stay behind the `import.meta.env.SSR` guard in src/storage/client.ts (plan step 5).
// Run after `pnpm build`.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '.output', 'server');
// The Nitro asset manifest in index.mjs lists the client's public files, so a bare `.wasm` name is
// not a finding there. These are code markers of the driver and of wa-sqlite.
const markers = ['OPFSCoopSyncVFS', 'openWasmStorage', 'wa-sqlite.mjs', 'kd-coop'];

// pdfjs-dist is traced next to the server for PDF extraction (phase 4 A4) and ships its own WASM
// image decoders: not the storage driver.
const allowed = new Set([join(root, 'node_modules', 'pdfjs-dist')]);

const problems = [];
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (allowed.has(path)) continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.wasm')) problems.push(`${path}: WASM file in the server output`);
    else if (/\.(m?js|cjs|json)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      for (const marker of markers) {
        if (text.includes(marker)) problems.push(`${path}: contains "${marker}"`);
      }
    }
  }
};

try {
  await walk(root);
} catch (error) {
  console.error(`Cannot read ${root}: run \`pnpm build\` first.`, error.message);
  process.exit(2);
}
if (problems.length > 0) {
  console.error(
    `Browser-only storage driver leaked into the server bundle:\n${problems.join('\n')}`,
  );
  process.exit(1);
}
console.log('Server bundle is clean: no SQLite WASM driver in .output/server.');
