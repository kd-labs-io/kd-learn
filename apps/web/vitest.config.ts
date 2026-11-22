import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests only. The app's vite.config.ts loads TanStack Start and Nitro, which tests do not need.
// `src/routes/` holds file routes, where `api.models.test.ts` is the `/api/models/test` route.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/routes/**'],
    environment: 'node',
  },
});
