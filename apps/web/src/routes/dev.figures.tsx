// Test harness for figures (phase 5 step 6). Playwright (apps/web/e2e/figures.e2e.ts) calls
// `window.__kdFigures.show(...)` with a message, its figures and their bodies, and switches the
// theme with `setVars`. Not linked from the app.
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/VStack';
import type { FigureInfo } from '@kd-learn/core';
import { defaultTheme, figureVars, type FigureVars } from '@kd-learn/tokens';
import { LessonFigure } from '@kd-learn/ui/components/LessonFigure';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const Route = createFileRoute('/dev/figures')({ component: DevFigures });

interface Shown {
  readonly content: string;
  readonly figures: ReadonlyArray<FigureInfo>;
  /** Text bodies as strings, image bodies as base64 under `{ base64 }`. */
  readonly bodies: Readonly<Record<string, string | { readonly base64: string }>>;
  readonly isStreaming?: boolean;
}

declare global {
  interface Window {
    __kdFigures?: {
      show: (shown: Shown) => void;
      setVars: (vars: Partial<FigureVars>) => void;
    };
  }
}

function DevFigures() {
  const [shown, setShown] = useState<Shown>();
  const [vars, setVars] = useState<FigureVars>(figureVars(defaultTheme));
  useEffect(() => {
    window.__kdFigures = {
      show: setShown,
      setVars: (change) => setVars((current) => ({ ...current, ...change })),
    };
    document.body.dataset.figuresReady = 'true';
    return () => {
      delete window.__kdFigures;
    };
  }, []);
  const figures = useMemo(
    () => new Map((shown?.figures ?? []).map((figure) => [figure.figureId, figure])),
    [shown],
  );
  const bodies = shown?.bodies;
  const loadBody = useCallback(
    async (figureId: string) => {
      const body = bodies?.[figureId];
      if (body === undefined || typeof body === 'string') return body;
      return Uint8Array.from(atob(body.base64), (char) => char.charCodeAt(0));
    },
    [bodies],
  );
  return (
    <VStack gap={4} padding={6}>
      <Heading level={1}>Figures</Heading>
      {shown === undefined ? null : (
        <LessonFigure
          figures={figures}
          loadBody={loadBody}
          vars={vars}
          isStreaming={shown.isStreaming ?? false}
        >
          {shown.content}
        </LessonFigure>
      )}
    </VStack>
  );
}
