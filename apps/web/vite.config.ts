import { astryxStylex } from '@astryxdesign/build/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig, type Plugin } from 'vite';

// One config, two outputs (plan 2.4):
// - default: SSR server for Docker (`.output/`)
// - KD_BUILD_TARGET=spa: static SPA for Capacitor
const spa = process.env.KD_BUILD_TARGET === 'spa';

// Astryx's post-build layer split looks for the StyleX CSS in each environment's
// output folder. Start and Nitro also build server environments that emit no
// CSS, where the check fails, so run it for the client build only.
const clientOnly = new Set(['astryx-build-layer-split']);
const astryx = (): Plugin[] =>
  astryxStylex().map((plugin) =>
    clientOnly.has(plugin.name)
      ? { ...plugin, applyToEnvironment: (environment) => environment.name === 'client' }
      : plugin,
  );

// KaTeX's CSS lists woff2, woff and ttf for every font, and Vite copies all three. Every browser we
// support reads woff2, so drop the other two sources: 19 woff2 files (256 kB) instead of 817 kB,
// which matters for the Capacitor bundle (plan step 7).
const katexWoff2Only = (): Plugin => ({
  name: 'kd-katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split('?')[0]!.endsWith('katex/dist/katex.min.css')) return null;
    return code.replace(
      /,url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g,
      '',
    );
  },
});

export default defineConfig({
  server: { port: 3000 },
  plugins: [
    katexWoff2Only(),
    tanstackStart(
      spa
        ? { spa: { enabled: true, prerender: { outputPath: '/index.html', crawlLinks: false } } }
        : {},
    ),
    ...(spa ? [] : [nitro()]),
    // StyleX for kd-learn components; splits Astryx and product CSS into layers.
    ...astryx(),
    // React's plugin must come after Start's.
    react(),
  ],
});
