import { colorVars, radiusVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';

export interface LessonTextProps {
  /** Lesson content: paragraphs, lists, code. */
  children: ReactNode;
  /** `callout` puts the text on a surface with the decorative accent rule. */
  variant?: 'plain' | 'callout';
}

/** Body text of a lesson step, kept at a readable 68ch measure (DESIGN.md). */
export function LessonText({ children, variant = 'plain' }: LessonTextProps) {
  return (
    <div {...stylex.props(styles.base, variant === 'callout' && styles.callout)}>{children}</div>
  );
}

const styles = stylex.create({
  base: {
    maxWidth: '68ch',
    fontFamily: 'var(--font-family-body)',
    fontSize: 'var(--text-body-size)',
    lineHeight: 'var(--text-body-leading)',
    color: colorVars['--color-text-primary'],
  },
  callout: {
    backgroundColor: colorVars['--color-background-surface'],
    borderInlineStartWidth: '4px',
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: 'var(--kd-color-accent)',
    borderRadius: radiusVars['--radius-container'],
    paddingBlock: spacingVars['--spacing-4'],
    paddingInline: spacingVars['--spacing-6'],
  },
});
