// Shared ESLint flat config for the kd-learn monorepo.
// Package boundaries (plan section 3.2) are enforced here with core rules only,
// so a violation is reported as a normal lint error.
import { builtinModules } from 'node:module';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeBuiltins = [...new Set(builtinModules.map((name) => name.replace(/^node:/, '')))];

/** Every Node builtin, both bare (`fs`) and prefixed (`node:fs`, `node:fs/promises`). */
const nodeBuiltinPatterns = [
  { group: ['node:*'], message: 'Node APIs are not allowed here. Do IO through a port.' },
  ...nodeBuiltins.map((name) => ({
    group: [name, `${name}/*`],
    message: 'Node APIs are not allowed here. Do IO through a port.',
  })),
];

/** Globals that mean IO or a host environment (DOM or Node). */
const hostGlobals = [
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'Buffer',
  'require',
  '__dirname',
  '__filename',
  'global',
].map((name) => ({ name, message: 'Host APIs are not allowed here. Do IO through a port.' }));

/** UI and web-only libraries. TanStack libraries live in apps/web and packages/ui only (plan 2.5). */
const uiLibraryPatterns = [
  {
    group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    message: 'UI code is not allowed here.',
  },
  {
    group: ['@tanstack/*'],
    message: 'TanStack libraries belong in apps/web and packages/ui only.',
  },
  { group: ['@astryxdesign/*', '@stylexjs/*'], message: 'UI code is not allowed here.' },
];

/** Allowed internal imports per package. Anything else under @kd-learn/* is rejected. */
const internalAllow = {
  core: [],
  agent: ['@kd-learn/core', '@kd-learn/ai/port', '@kd-learn/search/port', '@kd-learn/storage/port'],
  i18n: [],
  tokens: ['@kd-learn/core'],
  ui: ['@kd-learn/core', '@kd-learn/tokens', '@kd-learn/i18n'],
  storage: ['@kd-learn/core'],
  api: ['@kd-learn/core'],
  server: [
    '@kd-learn/core',
    '@kd-learn/agent',
    '@kd-learn/ai',
    '@kd-learn/api',
    '@kd-learn/search',
    '@kd-learn/storage',
  ],
};

/** Builds a pattern that rejects every @kd-learn/* import except the allowed ones. */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const internalPattern = (allowed) => ({
  regex: allowed.length
    ? `^@kd-learn/(?!(${allowed.map((name) => escape(name.slice('@kd-learn/'.length))).join('|')})($|/))`
    : '^@kd-learn/',
  message: `Only ${allowed.length ? allowed.join(', ') : 'no other @kd-learn package'} may be imported here (plan 3.2).`,
});

const restrict = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
});

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      '**/.tanstack/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/routeTree.gen.ts',
      '**/src/paraglide/**',
      '**/*.built/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Tooling files (configs, scripts) run in Node.
  {
    files: [
      '**/*.config.{js,ts,mjs}',
      '**/eslint.js',
      '**/scripts/**',
      '**/*.integration.mjs',
      '**/*.doc.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  // core: pure TS + Effect Schema. No IO, no host APIs, no UI, no other internal package.
  {
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      ...restrict([
        ...nodeBuiltinPatterns,
        ...uiLibraryPatterns,
        internalPattern(internalAllow.core),
      ]),
      'no-restricted-globals': ['error', ...hostGlobals],
    },
  },
  // agent: depends on core and port interfaces only.
  {
    files: ['packages/agent/**/*.{ts,tsx}'],
    rules: {
      ...restrict([
        ...nodeBuiltinPatterns,
        ...uiLibraryPatterns,
        internalPattern(internalAllow.agent),
      ]),
      'no-restricted-globals': ['error', ...hostGlobals],
    },
  },
  // i18n: plain data, usable on server and client.
  {
    files: ['packages/i18n/**/*.{ts,tsx}'],
    rules: restrict([
      ...nodeBuiltinPatterns,
      ...uiLibraryPatterns,
      internalPattern(internalAllow.i18n),
    ]),
  },
  // tokens: theme data + Astryx theme. No server code.
  {
    files: ['packages/tokens/src/**/*.{ts,tsx}'],
    rules: restrict([
      ...nodeBuiltinPatterns,
      {
        group: ['@tanstack/*'],
        message: 'TanStack libraries belong in apps/web and packages/ui only.',
      },
      internalPattern(internalAllow.tokens),
    ]),
  },
  // ui: browser components. No Node APIs, no server-side packages.
  {
    files: ['packages/ui/{components,src}/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    rules: restrict([...nodeBuiltinPatterns, internalPattern(internalAllow.ui)]),
  },
  // Packages other than apps/web and packages/ui must not use TanStack (plan 2.5),
  // except TanStack AI, which is the API backend of packages/ai (plan 2.4).
  {
    files: ['packages/search/**/*.{ts,tsx}'],
    rules: restrict([
      {
        group: ['@tanstack/*'],
        message: 'TanStack libraries belong in apps/web and packages/ui only.',
      },
    ]),
  },
  // storage: drivers may use host APIs (OPFS, node:sqlite). The port is checked below.
  {
    files: ['packages/storage/**/*.{ts,tsx}'],
    rules: restrict([...uiLibraryPatterns, internalPattern(internalAllow.storage)]),
  },
  // api: the HTTP contract runs in the browser and on the server. No Node APIs, no UI.
  {
    files: ['packages/api/**/*.{ts,tsx}'],
    rules: restrict([
      ...nodeBuiltinPatterns,
      ...uiLibraryPatterns,
      internalPattern(internalAllow.api),
    ]),
  },
  // server: runs in Node and wires adapters to agents. No UI, no browser-only packages.
  {
    files: ['packages/server/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.node },
    rules: restrict([...uiLibraryPatterns, internalPattern(internalAllow.server)]),
  },
  {
    files: ['packages/ai/**/*.{ts,tsx}'],
    rules: restrict([
      {
        regex: '^@tanstack/(?!ai($|-|/))',
        message: 'Only TanStack AI is allowed in packages/ai.',
      },
    ]),
  },
  // Ports are imported by agent, so they stay as pure as agent: Effect only.
  {
    files: ['packages/{ai,storage}/src/port/**/*.{ts,tsx}'],
    rules: {
      ...restrict([
        ...nodeBuiltinPatterns,
        ...uiLibraryPatterns,
        { group: ['@tanstack/*'], message: 'A port must not depend on an adapter.' },
        internalPattern(internalAllow.core),
      ]),
      'no-restricted-globals': ['error', ...hostGlobals],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
