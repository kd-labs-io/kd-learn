import { defineConfig } from 'vitest/config';

// Unit tests only. The app's vite.config.ts loads TanStack Start and Nitro, which tests do not need.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
