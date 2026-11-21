// SPIKE (phase 1 step 6): Markdown + KaTeX streaming spike page. Delete at step 7, together
// with src/spike/markdown, or turn the winner into the real component. Driven by
// apps/web/scripts/spike-markdown.mjs; not linked from the app.
//   /spike/markdown                          empty, waits for window.__mdSpike.run(...)
//   /spike/markdown?mode=static&r=astryx     renders the whole fixture in the first render (SSR check)
import { createFileRoute } from '@tanstack/react-router';
import { MarkdownSpike, type FixtureId, type RendererId } from '../spike/markdown/harness';

export const Route = createFileRoute('/spike/markdown')({
  validateSearch: (search: Record<string, unknown>) => ({
    mode: search.mode === 'static' ? ('static' as const) : ('stream' as const),
    r: search.r === 'astryx' ? ('astryx' as const) : ('tanstack' as const),
    f: search.f === 'hostile' ? ('hostile' as const) : ('teacher' as const),
  }),
  component: SpikeMarkdown,
});

function SpikeMarkdown() {
  const { mode, r, f } = Route.useSearch();
  const initial: { renderer: RendererId; fixture: FixtureId } | undefined =
    mode === 'static' ? { renderer: r, fixture: f } : undefined;
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>Markdown + KaTeX spike</h1>
      <MarkdownSpike initial={initial} />
    </main>
  );
}
