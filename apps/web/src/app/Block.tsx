import { Card } from '@astryxdesign/core/Card';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { VStack } from '@astryxdesign/core/VStack';
import type { ReactNode } from 'react';

type Gap = 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 | 8 | 10;

/**
 * A raised block for one section of a screen (DESIGN.md "UX"): a card a shade lighter than the
 * page, with a soft shadow and the same inner padding everywhere (24 px, 16 px on a phone).
 */
export function Block({
  children,
  gap = 4,
  'data-testid': testId,
}: {
  children: ReactNode;
  gap?: Gap;
  'data-testid'?: string;
}) {
  const wide = useMediaQuery('(min-width: 640px)');
  return (
    <Card padding={wide ? 6 : 4} elevation="low">
      <VStack gap={gap} data-testid={testId}>
        {children}
      </VStack>
    </Card>
  );
}
