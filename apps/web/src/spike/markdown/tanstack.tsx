// SPIKE (phase 1 step 6): candidate A, @tanstack/markdown (no math syntax of its own) plus a
// small math extension that emits `<kd-math>` nodes, mapped to KaTeX through `components`.
import type { InlineNode, MarkdownExtension } from '@tanstack/markdown';
import { streamingMarkdownExtension } from '@tanstack/markdown/extensions/streaming';
import { Markdown } from '@tanstack/markdown/react';
import { memo, useMemo } from 'react';
import { MathView } from './math';

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** `$...$` (pandoc rules: no space inside the delimiters, closer not followed by a digit) and `$$...$$`. */
export function mathExtension(streaming: boolean): MarkdownExtension {
  return {
    name: 'math',
    parseBlock(ctx) {
      const first = (ctx.lines[ctx.index] ?? '').trim();
      if (!first.startsWith('$$')) return undefined;
      if (first.length >= 4 && first.endsWith('$$')) {
        ctx.consume(1);
        return mathNode(first.slice(2, -2).trim(), true, false);
      }
      const body: string[] = [first.slice(2)];
      let cursor = ctx.index + 1;
      while (cursor < ctx.lines.length) {
        const line = ctx.lines[cursor] ?? '';
        if (line.trimEnd().endsWith('$$')) {
          body.push(line.trimEnd().slice(0, -2));
          ctx.consume(cursor - ctx.index + 1);
          return mathNode(body.join('\n').trim(), true, false);
        }
        body.push(line);
        cursor++;
      }
      // No closer. While streaming, show the source as a placeholder; otherwise it is plain text.
      if (!streaming) return undefined;
      ctx.consume(ctx.lines.length - ctx.index);
      return mathNode(body.join('\n').trim(), true, true);
    },
    inlineParser: {
      markers: '$',
      parse({ source, index, inLink }) {
        if (inLink || source[index] !== '$') return undefined;
        const next = source[index + 1];
        if (next === '$') {
          const close = source.indexOf('$$', index + 2);
          if (close === -1) return undefined;
          return {
            node: mathInline(source.slice(index + 2, close).trim()),
            length: close + 2 - index,
          };
        }
        if (isSpace(next)) return undefined;
        for (let j = index + 1; j < source.length; j++) {
          const c = source[j];
          if (c === '\\') {
            j++;
            continue;
          }
          if (c === '$' && !isSpace(source[j - 1]) && !/\d/.test(source[j + 1] ?? '')) {
            return { node: mathInline(source.slice(index + 1, j)), length: j + 1 - index };
          }
        }
        return undefined;
      },
    },
  };
}

function mathInline(tex: string): InlineNode {
  return {
    type: 'inlineComponent',
    name: 'math',
    tagName: 'kd-math',
    attributes: {},
    properties: { 'data-tex': tex, 'data-display': 'inline' },
    children: [],
  };
}

function mathNode(tex: string, _block: true, pending: boolean) {
  return {
    type: 'component' as const,
    name: 'math',
    tagName: 'kd-math',
    attributes: {},
    properties: {
      'data-tex': tex,
      'data-display': 'block',
      ...(pending ? { 'data-pending': '' } : {}),
    },
    children: [],
  };
}

interface KdMathProps {
  'data-tex': string;
  'data-display': 'inline' | 'block';
  'data-pending'?: string;
}

const KdMath = memo(function KdMath(props: KdMathProps) {
  return (
    <MathView
      tex={props['data-tex']}
      display={props['data-display'] === 'block'}
      pending={props['data-pending'] !== undefined}
    />
  );
});

// Module-level so the Markdown options keep a stable identity between chunks.
const components = { 'kd-math': KdMath };
const extensionsStreaming = [mathExtension(true), streamingMarkdownExtension()];
const extensionsFinal = [mathExtension(false)];

export const TanstackMarkdown = memo(function TanstackMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const extensions = useMemo(
    () => (streaming ? extensionsStreaming : extensionsFinal),
    [streaming],
  );
  // allowHtml stays at its default (false): raw HTML is shown as text, never as markup.
  return (
    <div data-renderer="tanstack" className="spike-md">
      <Markdown extensions={extensions} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
