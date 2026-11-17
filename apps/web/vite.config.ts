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

export default defineConfig({
  server: { port: 3000 },
  plugins: [
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
