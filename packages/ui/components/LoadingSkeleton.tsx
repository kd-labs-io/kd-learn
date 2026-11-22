import { Skeleton } from '@astryxdesign/core/Skeleton';
import { spacingVars } from '@astryxdesign/core/theme/tokens.stylex';
import * as stylex from '@stylexjs/stylex';

export interface LoadingSkeletonProps {
  /** What is loading, read by screen readers (the shimmer has no visible text). */
  label: string;
  /** `text`: a heading and paragraph lines. `list`: stacked rows, like a List of Items. */
  variant?: 'text' | 'list';
  /** Number of lines or rows. */
  rows?: number;
}

const lineWidths = ['100%', '94%', '82%', '96%', '68%'];

/** Shimmer placeholder in the shape of the content that is loading (DESIGN.md "UX"). */
export function LoadingSkeleton({ label, variant = 'text', rows = 3 }: LoadingSkeletonProps) {
  const items = Array.from({ length: rows }, (_, i) => i);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-testid="loading"
      {...stylex.props(styles.base, variant === 'list' ? styles.list : styles.text)}
    >
      {variant === 'list' ? (
        items.map((i) => <Skeleton key={i} index={i} height={56} />)
      ) : (
        <>
          <Skeleton index={0} width="40%" height={24} />
          {items.map((i) => (
            <Skeleton
              key={i}
              index={i + 1}
              width={lineWidths[i % lineWidths.length] ?? '100%'}
              height={14}
              radius="rounded"
            />
          ))}
        </>
      )}
    </div>
  );
}

const styles = stylex.create({
  base: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
  },
  text: { gap: spacingVars['--spacing-3'] },
  list: { gap: spacingVars['--spacing-2'] },
});
