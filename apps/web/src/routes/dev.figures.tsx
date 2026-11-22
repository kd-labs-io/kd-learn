// Test harness for figures (phase 5 step 6). Playwright (apps/web/e2e/figures.e2e.ts) calls
// `window.__kdFigures.show(...)` with a message, its figures and their bodies, and switches the
// theme with `setVars` (overrides) or `setAppearance` (the app's mode and theme). Not linked from
// the app.
import { Heading } from '@astryxdesign/core/Heading';
import { VStack } from '@astryxdesign/core/VStack';
import type { FigureInfo } from '@kd-learn/core';
import type { Appearance } from '@kd-learn/api';
import type { FigureVars } from '@kd-learn/tokens';
import { LessonFigure } from '@kd-learn/ui/components/LessonFigure';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { figureVarsOf } from '../learn/figures';
import { useThemeControl } from '../theme/ThemeRoot';

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
      setAppearance: (appearance: Appearance) => void;
    };
  }
}

function DevFigures() {
  const [shown, setShown] = useState<Shown>();
  // The app's theme and mode (as in a lesson), with test overrides on top.
  const { theme, resolvedMode, setAppearance } = useThemeControl();
  const [overrides, setOverrides] = useState<Partial<FigureVars>>({});
  const vars = useMemo(
    () => ({ ...figureVarsOf(theme, resolvedMode), ...overrides }) as FigureVars,
    [theme, resolvedMode, overrides],
  );
  useEffect(() => {
    window.__kdFigures = {
      show: setShown,
      setVars: (change) => setOverrides((current) => ({ ...current, ...change })),
      setAppearance,
    };
    document.body.dataset.figuresReady = 'true';
    return () => {
      delete window.__kdFigures;
    };
  }, [setAppearance]);
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
