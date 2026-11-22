import * as stylex from '@stylexjs/stylex';

/** The one way a figure reaches the page as a picture: an `<img>` on a blob URL (plan A3). */
export function FigureImage({
  src,
  alt,
  isLarge = false,
}: {
  src: string;
  alt: string;
  isLarge?: boolean;
}) {
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      data-testid="figure-image"
      {...stylex.props(styles.base, isLarge && styles.large)}
    />
  );
}

const styles = stylex.create({
  base: { display: 'block', maxWidth: '100%', height: 'auto', maxHeight: '60vh' },
  large: { maxHeight: '80vh', width: '100%', objectFit: 'contain' },
});
