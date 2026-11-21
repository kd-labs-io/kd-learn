// KaTeX view used by LessonMarkdown. Loaded lazily; keeps the formula CSS out of the main bundle.
// The app's Vite config strips the woff and ttf sources from the KaTeX CSS (woff2 is enough for
// every browser Astryx supports), so only the woff2 files are copied into the build.
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { memo } from 'react';

const cache = new Map<string, string>();

/** KaTeX output is generated markup, not model text; `trust: false` blocks \href, \url, \htmlClass... */
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

export interface KatexMathProps {
  tex: string;
  display: boolean;
}

/** Memoized: a streamed document re-renders the same formulas on every chunk. */
const KatexMath = memo(function KatexMath({ tex, display }: KatexMathProps) {
  const html = texToHtml(tex, display);
  return display ? (
    <div dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span dangerouslySetInnerHTML={{ __html: html }} />
  );
});

export default KatexMath;
