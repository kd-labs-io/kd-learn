import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { demoLibrary, type DemoLibraryId } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import type { FigureVars } from '@kd-learn/tokens';
import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { buildFrameDoc, FrameUnavailable, schemeOf } from './frame-doc.ts';
import { readFrameMessage } from './messages.ts';

type Run =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'running'; readonly doc: string; readonly id: number }
  | { readonly _tag: 'unavailable' };

/**
 * An HTML demo (plan A2, A5). It never runs by itself: an infinite loop would freeze the whole page
 * (spike C1), so the learner presses Run. Stop removes the frame.
 */
export function DemoFigure({
  title,
  html,
  libraries,
  vars,
}: {
  title: string;
  html: string;
  libraries: ReadonlyArray<DemoLibraryId> | undefined;
  vars: FigureVars;
}) {
  const [run, setRun] = useState<Run>({ _tag: 'idle' });
  const [height, setHeight] = useState(160);
  const [error, setError] = useState<string>();
  const frame = useRef<HTMLIFrameElement>(null);
  const runs = useRef(0);

  const start = async () => {
    setError(undefined);
    try {
      const doc = await buildFrameDoc({ html, vars, ...(libraries ? { libraries } : {}) });
      setRun({ _tag: 'running', doc, id: ++runs.current });
    } catch (cause) {
      if (cause instanceof FrameUnavailable) setRun({ _tag: 'unavailable' });
      else throw cause;
    }
  };

  useEffect(() => {
    if (run._tag !== 'running') return;
    const onMessage = (event: MessageEvent) => {
      if (frame.current === null || event.source !== frame.current.contentWindow) return;
      const message = readFrameMessage(event.data);
      if (message?.type === 'resize') setHeight(message.height);
      if (message?.type === 'error') setError(message.message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [run]);

  // A theme change reaches a running demo as a message; it never gets anything else.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: 'theme', vars, scheme: schemeOf(vars) }, '*');
  }, [vars]);

  const names = (libraries ?? []).flatMap((id) => {
    const library = demoLibrary(id);
    return library === undefined ? [] : [`${library.name} ${library.version}`];
  });

  return (
    <VStack gap={1} data-testid="figure-demo">
      <HStack gap={1}>
        <Text type="supporting" color="secondary">
          {title}
        </Text>
        <Text type="label" color="secondary">
          {m.figure_demo_label()}
        </Text>
      </HStack>
      {names.length > 0 ? (
        <Text type="label" color="secondary">
          {m.figure_demo_libraries({ list: names.join(', ') })}
        </Text>
      ) : null}
      {run._tag === 'running' ? (
        <iframe
          key={run.id}
          ref={frame}
          title={title}
          sandbox="allow-scripts"
          srcDoc={run.doc}
          referrerPolicy="no-referrer"
          data-testid="figure-frame"
          {...stylex.props(styles.frame, styles.height(height))}
        />
      ) : null}
      {run._tag === 'unavailable' ? (
        <Text type="supporting" color="secondary" display="block">
          {m.figure_demo_unavailable()}
        </Text>
      ) : null}
      {error === undefined ? null : (
        <Text type="supporting" color="secondary" display="block" data-testid="figure-demo-error">
          {m.figure_demo_error({ message: error })}
        </Text>
      )}
      <HStack gap={1}>
        {run._tag === 'running' ? (
          <>
            <Button
              size="sm"
              label={m.figure_demo_stop()}
              onClick={() => setRun({ _tag: 'idle' })}
            />
            <Button size="sm" variant="ghost" label={m.figure_demo_rerun()} clickAction={start} />
          </>
        ) : (
          <Button size="sm" variant="primary" label={m.figure_demo_run()} clickAction={start} />
        )}
      </HStack>
    </VStack>
  );
}

const styles = stylex.create({
  frame: {
    display: 'block',
    width: '100%',
    maxHeight: '80vh',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--color-border)',
    borderRadius: 'var(--radius-container)',
    backgroundColor: 'var(--color-background-body)',
  },
  height: (height: number) => ({ height }),
});
