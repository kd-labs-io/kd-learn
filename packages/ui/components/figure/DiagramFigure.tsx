import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog } from '@astryxdesign/core/Dialog';
import { DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import type { FigureVars } from '@kd-learn/tokens';
import { useEffect, useState } from 'react';
import { FigureImage } from './FigureImage.tsx';
import { rootStyle } from './frame-doc.ts';
import { renderMermaid } from './mermaid.ts';
import { prepareSvg } from './svg.ts';
import { useObjectUrl } from './use-object-url.ts';

type Drawn = { readonly svg: string } | { readonly error: string } | undefined;

/** An SVG or Mermaid figure, as an image; redrawn when the theme changes (plan A3, A4). */
export function DiagramFigure({
  kind,
  title,
  source,
  vars,
}: {
  kind: 'svg' | 'mermaid';
  title: string;
  source: string;
  vars: FigureVars;
}) {
  const [drawn, setDrawn] = useState<Drawn>();
  const [isZoomed, setZoomed] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    let live = true;
    const css = rootStyle(vars);
    const finish = (svg: string) => {
      const prepared = prepareSvg(svg, css);
      if (live) setDrawn(prepared.ok ? { svg: prepared.svg } : { error: prepared.error });
    };
    if (kind === 'svg') finish(source);
    else {
      renderMermaid(source, vars).then(finish, (error: unknown) => {
        if (live)
          setDrawn({
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          });
      });
    }
    return () => {
      live = false;
    };
  }, [kind, source, vars]);

  const url = useObjectUrl(
    () =>
      drawn !== undefined && 'svg' in drawn
        ? new Blob([drawn.svg], { type: 'image/svg+xml' })
        : undefined,
    [drawn],
  );
  const code = (
    <CodeBlock
      code={source}
      language={kind === 'svg' ? 'xml' : 'plaintext'}
      maxHeight={320}
      isWrapped
    />
  );

  if (drawn !== undefined && 'error' in drawn) {
    return (
      <VStack gap={1} data-testid="figure-error">
        <Text type="supporting" color="secondary" display="block">
          {kind === 'svg'
            ? m.figure_invalid_svg({ reason: drawn.error })
            : m.figure_invalid_mermaid({ reason: drawn.error })}
        </Text>
        {code}
      </VStack>
    );
  }
  return (
    <VStack gap={1}>
      {url === undefined ? (
        <Text type="supporting" color="secondary">
          {m.figure_preparing()}
        </Text>
      ) : (
        <FigureImage src={url} alt={title} />
      )}
      <HStack gap={1}>
        <Text type="supporting" color="secondary">
          {title}
        </Text>
        <Button
          size="sm"
          variant="ghost"
          label={m.figure_zoom()}
          onClick={() => setZoomed(true)}
          isDisabled={url === undefined}
        />
        <Button
          size="sm"
          variant="ghost"
          label={showCode ? m.figure_hide_code() : m.figure_show_code()}
          onClick={() => setShowCode(!showCode)}
        />
      </HStack>
      {showCode ? code : null}
      <Dialog isOpen={isZoomed} onOpenChange={setZoomed} width="90vw" maxHeight="90dvh">
        <DialogHeader title={title} />
        {url === undefined || !isZoomed ? null : <FigureImage src={url} alt={title} isLarge />}
      </Dialog>
    </VStack>
  );
}
