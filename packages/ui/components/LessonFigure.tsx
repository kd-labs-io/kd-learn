import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { splitFigureMarkers, type FigureInfo } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import type { FigureVars } from '@kd-learn/tokens';
import { memo, useEffect, useState } from 'react';
import { DemoFigure } from './figure/DemoFigure.tsx';
import { DiagramFigure } from './figure/DiagramFigure.tsx';
import { FigureImage } from './figure/FigureImage.tsx';
import { useObjectUrl } from './figure/use-object-url.ts';
import { LessonMarkdown } from './LessonMarkdown.tsx';

export type FigureBodyLoader = (figureId: string) => Promise<string | Uint8Array | undefined>;

export interface LessonFigureProps {
  /** Message text from the model, with `[[figure:<id>]]` markers. Untrusted. */
  children: string;
  /** Figures known for this message (from `FigureAdded`). */
  figures: ReadonlyMap<string, FigureInfo>;
  /** Reads a figure body: local DB for guests, the account API otherwise. */
  loadBody: FigureBodyLoader;
  /** Figure colors of the current theme (`figureVars`). */
  vars: FigureVars;
  isStreaming?: boolean;
}

type Body =
  | { readonly _tag: 'loading' }
  | { readonly _tag: 'ok'; readonly body: string | Uint8Array }
  | { readonly _tag: 'failed' };

function useBody(figureId: string, loadBody: FigureBodyLoader): Body {
  const [body, setBody] = useState<Body>({ _tag: 'loading' });
  useEffect(() => {
    let live = true;
    setBody({ _tag: 'loading' });
    loadBody(figureId).then(
      (value) =>
        live && setBody(value === undefined ? { _tag: 'failed' } : { _tag: 'ok', body: value }),
      () => live && setBody({ _tag: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [figureId, loadBody]);
  return body;
}

function Note({ children }: { children: string }) {
  return (
    <Text type="supporting" color="secondary" display="block" data-testid="figure-note">
      {children}
    </Text>
  );
}

const asText = (body: string | Uint8Array) =>
  typeof body === 'string' ? body : new TextDecoder().decode(body);

function ImageFigure({ info, bytes }: { info: FigureInfo; bytes: Uint8Array }) {
  const url = useObjectUrl(
    () => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: info.mime }),
    [bytes, info.mime],
  );
  const [isZoomed, setZoomed] = useState(false);
  return url === undefined ? null : (
    <VStack gap={1}>
      <FigureImage src={url} alt={info.title} />
      <HStack gap={1}>
        <Text type="supporting" color="secondary">
          {info.title}
        </Text>
        <Button size="sm" variant="ghost" label={m.figure_zoom()} onClick={() => setZoomed(true)} />
      </HStack>
      <Dialog isOpen={isZoomed} onOpenChange={setZoomed} width="90vw" maxHeight="90dvh">
        <DialogHeader title={info.title} />
        {isZoomed ? <FigureImage src={url} alt={info.title} isLarge /> : null}
      </Dialog>
    </VStack>
  );
}

function LoadedFigure({
  info,
  loadBody,
  vars,
}: {
  info: FigureInfo;
  loadBody: FigureBodyLoader;
  vars: FigureVars;
}) {
  const body = useBody(info.figureId, loadBody);
  if (body._tag === 'loading') return <Note>{m.figure_preparing()}</Note>;
  if (body._tag === 'failed') return <Note>{m.figure_load_failed()}</Note>;
  switch (info.kind) {
    case 'svg':
    case 'mermaid':
      return (
        <DiagramFigure kind={info.kind} title={info.title} source={asText(body.body)} vars={vars} />
      );
    case 'html':
      return (
        <DemoFigure
          title={info.title}
          html={asText(body.body)}
          libraries={info.libraries}
          vars={vars}
        />
      );
    case 'image':
      return typeof body.body === 'string' ? (
        <Note>{m.figure_load_failed()}</Note>
      ) : (
        <ImageFigure info={info} bytes={body.body} />
      );
  }
}

/**
 * A Teacher message with its figures (plan A8): text through `LessonMarkdown`, each marker as a
 * figure. A marker with no known figure is a placeholder while the turn streams (the body comes at
 * the end of the turn), and a short note afterwards. Figures never enter the app's DOM as markup:
 * pictures are `<img>` on blob URLs, demos run in a sandboxed frame.
 */
export const LessonFigure = memo(function LessonFigure({
  children,
  figures,
  loadBody,
  vars,
  isStreaming = false,
}: LessonFigureProps) {
  const segments = splitFigureMarkers(children);
  return (
    <VStack gap={3}>
      {segments.map((segment, index) => {
        if (segment._tag === 'text') {
          return (
            <LessonMarkdown key={index} isStreaming={isStreaming && index === segments.length - 1}>
              {segment.text}
            </LessonMarkdown>
          );
        }
        const info = figures.get(segment.figureId);
        if (info === undefined) {
          return <Note key={index}>{isStreaming ? m.figure_preparing() : m.figure_missing()}</Note>;
        }
        return (
          <LoadedFigure
            key={`${index}-${info.figureId}`}
            info={info}
            loadBody={loadBody}
            vars={vars}
          />
        );
      })}
    </VStack>
  );
});
