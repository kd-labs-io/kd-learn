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
  const [, , boxWidth, boxHeight] = box;
  const width = Number.parseFloat(root.getAttribute('width') ?? '') || boxWidth || 300;
  const height = Number.parseFloat(root.getAttribute('height') ?? '') || boxHeight || 150;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  const style = doc.createElementNS(SVG_NS, 'style');
  style.textContent = rootCss;
  root.insertBefore(style, root.firstChild);
  return { ok: true, svg: new XMLSerializer().serializeToString(root), width, height };
};

/** An object URL for the SVG. The caller revokes it. */
export const svgUrl = (svg: string) =>
  URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
