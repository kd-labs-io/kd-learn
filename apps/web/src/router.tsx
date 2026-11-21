import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { onUserChange } from './account/auth';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  // One client per router: on the server that is one per request, so nothing leaks between users.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false } },
  });
  // A different user must not see the previous user's cached data.
  if (typeof window !== 'undefined') onUserChange(() => queryClient.clear());
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: { queryClient },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
