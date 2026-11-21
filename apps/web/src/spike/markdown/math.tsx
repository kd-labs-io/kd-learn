// SPIKE (phase 1 step 6): KaTeX view shared by both renderers.
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { memo } from 'react';

const cache = new Map<string, string>();

/** KaTeX output is generated markup (not model text); `trust: false` blocks \href, \url, \htmlClass... */
export function texToHtml(tex: string, display: boolean): string {
  const key = `${display ? 'b' : 'i'}:${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = katex.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    maxSize: 20,
    maxExpand: 200,
    output: 'htmlAndMathml',
  });
  if (cache.size > 500) cache.clear();
  cache.set(key, html);
  return html;
}

export interface MathViewProps {
  tex: string;
  display: boolean;
  /** Block math whose closing `$$` has not arrived yet. */
  pending?: boolean;
}

/** Memoized: a streamed document re-renders the same math on every chunk. */
export const MathView = memo(function MathView({ tex, display, pending }: MathViewProps) {
  if (pending) {
    return (
      <pre data-pending="" data-math-placeholder="">
        {tex}
      </pre>
    );
  }
  const html = texToHtml(tex, display);
  return display ? (
    <div data-math-block="" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span data-math-inline="" dangerouslySetInnerHTML={{ __html: html }} />
  );
});
