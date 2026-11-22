import { Link } from '@astryxdesign/core/Link';
import { Markdown } from '@astryxdesign/core/Markdown';
import { Text } from '@astryxdesign/core/Text';
import { m } from '@kd-learn/i18n';
import { lazy, memo, Suspense, type ReactNode } from 'react';

export interface LessonMarkdownProps {
  /** Markdown text from the model. Treated as untrusted. */
  children: string;
  /** True while the text is still arriving: unfinished syntax is held back instead of flashing. */
  isStreaming?: boolean;
}

// KaTeX is about 77 kB gzip with its CSS: load it the first time a formula shows up, or earlier
// with `preloadMath` (one shared import, so the lazy component reuses it).
let katexModule: Promise<typeof import('./katex-math')> | undefined;
const loadKatex = () => (katexModule ??= import('./katex-math'));
const KatexMath = lazy(loadKatex);

/**
 * Starts loading KaTeX now. A lesson calls it as it opens, while its log is still being read, so a
 * reloaded lesson shows formulas rendered instead of raw TeX for a moment (plan cai-thien-ux.md).
 */
export const preloadMath = (): void => {
  void loadKatex().catch(() => {
    // Retried by the lazy component when a formula renders.
    katexModule = undefined;
  });
};

function MathExpression({ value, display }: { value: string; display: 'inline' | 'block' }) {
  return (
    <Suspense
      fallback={
        <Text type="code" display={display === 'block' ? 'block' : 'inline'}>
          {value}
        </Text>
      }
    >
      <KatexMath tex={value} display={display === 'block'} />
    </Suspense>
  );
}

/**
 * Model images are never loaded: a `![](https://...)` makes the browser call a host the model
 * chose, which leaks data in the URL and lets a third party track the learner (plan risk 21).
 * The alt text is shown instead.
 */
function ModelImage({ alt }: { src: string; alt: string }) {
  return (
    <Text type="supporting" color="secondary" display="block">
      {m.markdown_image_omitted({ alt: alt === '' ? '-' : alt })}
    </Text>
  );
}

/**
 * Only absolute http(s) links are links, and they open in a new tab with no referrer. Anything
 * else (`mailto:`, a relative path, a fragment that would navigate the app) stays plain text.
 * Astryx already drops `javascript:` and `data:` destinations before this runs.
 */
function ModelLink({ href, children }: { href: string; children: ReactNode }) {
  if (!/^https?:\/\//i.test(href)) return <>{children}</>;
  return (
    <Link
      href={href}
      isExternalLink
      referrerPolicy="no-referrer"
      rel="noopener noreferrer nofollow"
    >
      {children}
    </Link>
  );
}

// Module-level so the object is stable and the memo below holds between chunks.
const components = { math: MathExpression, image: ModelImage, link: ModelLink };

/**
 * Renders what a tutor model writes: Markdown with `$...$` / `$$...$$` math (KaTeX), safe against
 * hostile text (no HTML, no `trust`, no remote images, constrained links).
 */
export const LessonMarkdown = memo(function LessonMarkdown({
  children,
  isStreaming = false,
}: LessonMarkdownProps) {
  return (
    <Markdown isStreaming={isStreaming} components={components} contentWidth="68ch">
      {children}
    </Markdown>
  );
});
