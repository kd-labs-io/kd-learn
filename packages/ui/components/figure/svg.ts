// SVG figures (plan A3, spike C2): shown only as `<img src="blob:...">`, where scripts never run and
// nothing external loads. The source is checked with DOMParser, the theme colors are injected as a
// style, and width / height come from the viewBox so the image has a size.
export type PreparedSvg =
  | { readonly ok: true; readonly svg: string; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly error: string };

const SVG_NS = 'http://www.w3.org/2000/svg';

export const prepareSvg = (source: string, rootCss: string): PreparedSvg => {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const failure = doc.getElementsByTagName('parsererror')[0];
  if (failure !== undefined) {
    return { ok: false, error: (failure.textContent ?? 'Not valid SVG.').trim().slice(0, 300) };
  }
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) {
    return { ok: false, error: 'The root element is not <svg>.' };
  }
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , boxWidth = 0, boxHeight = 0] = box;
  const ratio = boxWidth > 0 && boxHeight > 0 ? boxHeight / boxWidth : undefined;
  // Only plain lengths count: Mermaid writes `width="100%"`, which an image cannot size from.
  const length = (name: string) => {
    const value = (root.getAttribute(name) ?? '').trim();
    const number = /^\d+(\.\d+)?(px)?$/.test(value) ? Number.parseFloat(value) : 0;
    return number > 0 ? number : undefined;
  };
  let width = length('width');
  let height = length('height');
  if (width === undefined && height === undefined) {
    width = boxWidth > 0 ? boxWidth : 300;
    height = boxHeight > 0 ? boxHeight : 150;
  } else if (width === undefined) {
    width = ratio === undefined ? 300 : height! / ratio;
  } else if (height === undefined) {
    height = ratio === undefined ? 150 : width * ratio;
  }
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  // An inline max-width would shrink the drawing inside the image.
  root.style.removeProperty('max-width');
  const style = doc.createElementNS(SVG_NS, 'style');
  style.textContent = rootCss;
  root.insertBefore(style, root.firstChild);
  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(root),
    width: width!,
    height: height!,
  };
};

/** An object URL for the SVG. The caller revokes it. */
export const svgUrl = (svg: string) =>
  URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
