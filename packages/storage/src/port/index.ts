// Storage port (plan 3.2): append events, read sessions, settings.
// Pure: only `effect` may be imported here, so `packages/agent` may depend on it.
// The shape is fixed in step 5, after the SQLite WASM spike (step 1).
export {};
