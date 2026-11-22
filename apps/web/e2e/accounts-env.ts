// Ports and the admin of the accounts server in the browser tests (see playwright.config.ts).
// `KD_E2E_PORT_OFFSET` moves every port, so two checkouts (git worktrees) can run their tests at
// the same time without reusing each other's servers.
export const portOffset = Number(process.env['KD_E2E_PORT_OFFSET'] ?? 0);
export const guestPort = 4173 + portOffset;
export const accountsPort = 4174 + portOffset;
export const fakeModelPort = 4175 + portOffset;
export const fakeSearchPort = 4176 + portOffset;
// A server of its own that `restart.e2e.ts` kills and starts again.
export const restartPort = 4177 + portOffset;
export const E2E_ADMIN = { email: 'admin@e2e.test', password: 'admin-password-e2e' };
