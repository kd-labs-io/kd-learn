import { colorVars, spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';

export interface WorkingTextProps {
  /** What is happening, e.g. "The tutor is writing…". */
  label: string;
  /** `false` shows only the dots (the label is still read by screen readers). */
  showLabel?: boolean;
}

const bounce = stylex.keyframes({
  '0%, 80%, 100%': { transform: 'translateY(0)', opacity: 0.35 },
  '40%': { transform: 'translateY(-3px)', opacity: 1 },
});

const shimmer = stylex.keyframes({
  from: { backgroundPosition: '100% 0' },
  to: { backgroundPosition: '-100% 0' },
});

/** A running task: three pulsing dots and a shimmering label, in place of a spinner. */
export function WorkingText({ label, showLabel = true }: WorkingTextProps) {
  return (
    <span role="status" aria-label={label} {...stylex.props(styles.base)}>
      <span aria-hidden="true" {...stylex.props(styles.dots)}>
        {[0, 1, 2].map((i) => (
          <span key={i} {...stylex.props(styles.dot, delays[i])} />
        ))}
      </span>
      {showLabel ? (
        <span aria-hidden="true" {...stylex.props(styles.label)}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

const reduced = '@media (prefers-reduced-motion: reduce)';

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacingVars['--spacing-2'],
    minWidth: 0,
  },
  dots: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25em',
    flexShrink: 0,
  },
  dot: {
    width: '0.4em',
    height: '0.4em',
    borderRadius: '50%',
    backgroundColor: colorVars['--color-icon-accent'],
    animationName: { default: bounce, [reduced]: 'none' },
    animationDuration: '1.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    opacity: { default: null, [reduced]: 0.7 },
  },
  label: {
    fontFamily: 'var(--font-family-body)',
    fontSize: 'var(--text-supporting-size)',
    lineHeight: 'var(--text-supporting-leading)',
    color: { default: 'transparent', [reduced]: colorVars['--color-text-secondary'] },
    backgroundImage: `linear-gradient(90deg, ${colorVars['--color-text-secondary']} 35%, ${colorVars['--color-text-primary']} 50%, ${colorVars['--color-text-secondary']} 65%)`,
    backgroundSize: '200% 100%',
    backgroundClip: 'text',
    WebkitBackgroundClip: 'text',
    animationName: { default: shimmer, [reduced]: 'none' },
    animationDuration: '2s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
});

const delayStyles = stylex.create({
  d0: { animationDelay: '0s' },
  d1: { animationDelay: '0.15s' },
  d2: { animationDelay: '0.3s' },
});

const delays = [delayStyles.d0, delayStyles.d1, delayStyles.d2];
