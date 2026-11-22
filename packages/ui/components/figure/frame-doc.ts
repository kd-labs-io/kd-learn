// The document of a demo frame (plan hinh-va-demo.md A2, spike C1). The app builds it around the
// model's HTML: a fixed head first (CSP, referrer, theme, the app's script), then the model's body.
// The CSP allows scripts only by hash: each inline script and `on*` attribute of the model's HTML as
// parsed here, the app's script, and the SRI hash of each declared library. Dynamic scripts, eval
// and `<script src>` the model wrote itself are blocked.
import { demoLibrary, type DemoLibraryId } from '@kd-learn/core';

/** `crypto.subtle` exists only in a secure context (HTTPS or localhost). */
export class FrameUnavailable extends Error {}

/** Largest height a frame may ask for, in CSS pixels: model code can send anything. */
export const MAX_FRAME_HEIGHT = 4000;

// Runs first in the frame: reports errors, CSP violations and the height, and applies theme
// messages from the parent. Kept small and constant so its hash is stable.
export const FRAME_SCRIPT = `(() => {
  const post = (message) => parent.postMessage(message, '*');
  const text = (value) => String(value).slice(0, 300);
  addEventListener('error', (e) => post({ type: 'error', message: text(e.message) }));
  addEventListener('unhandledrejection', (e) => post({ type: 'error', message: text(e.reason) }));
  addEventListener('securitypolicyviolation', (e) =>
    post({ type: 'error', message: text('Blocked by the sandbox: ' + e.violatedDirective) }));
  const size = () => post({ type: 'resize', height: Math.ceil(document.documentElement.scrollHeight) });
  new ResizeObserver(size).observe(document.documentElement);
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.type !== 'theme') return;
    for (const [name, value] of Object.entries(e.data.vars || {})) {
      if (/^--kd-[a-z0-9-]+$/.test(name) && typeof value === 'string') {
        document.documentElement.style.setProperty(name, value);
      }
    }
    if (e.data.scheme === 'light' || e.data.scheme === 'dark') {
      document.documentElement.style.colorScheme = e.data.scheme;
    }
  });
  addEventListener('load', () => { size(); post({ type: 'ready' }); });
})();`;

const base64 = (bytes: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256 = async (text: string) => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new FrameUnavailable('crypto.subtle is not available');
  return `'sha256-${base64(await subtle.digest('SHA-256', new TextEncoder().encode(text)))}'`;
};

const escapeAttr = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

/**
 * The color scheme of a set of figure colors, from the luminance of `--kd-bg` (plan
 * theme-va-dien-thoai.md A4): the frame's own controls (buttons, inputs, scrollbars) then match.
 */
export const schemeOf = (vars: Readonly<Record<string, string>>): 'light' | 'dark' => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(vars['--kd-bg'] ?? '');
  if (match === null) return 'light';
  const digits = match[1]!;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? 'dark' : 'light';
};

/** `:root { --kd-fg: ...; color: ...; background: ... }`. Names and values are checked. */
export const rootStyle = (vars: Readonly<Record<string, string>>) => {
  const lines = Object.entries(vars)
    .filter(([name, value]) => /^--kd-[a-z0-9-]+$/.test(name) && /^[#\w\s.,()%-]+$/.test(value))
    .map(([name, value]) => `${name}: ${value};`);
  return `:root { ${lines.join(' ')} color: var(--kd-fg); background: var(--kd-bg); color-scheme: ${schemeOf(vars)}; }`;
};

export interface FrameInput {
  /** The model's HTML (a body fragment, or a whole document). Untrusted. */
  readonly html: string;
  readonly libraries?: ReadonlyArray<DemoLibraryId>;
  /** Figure colors (`--kd-*`), from `figureVars`. */
  readonly vars: Readonly<Record<string, string>>;
}

/**
 * Builds the `srcdoc` of a demo frame. The hashes are computed on the HTML as parsed and the body
 * is serialized from that same parse, so what is hashed is what runs. Throws `FrameUnavailable`
 * outside a secure context.
 */
export const buildFrameDoc = async ({
  html,
  libraries = [],
  vars,
}: FrameInput): Promise<string> => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  // A whole document from the model: its head styles and scripts move to the start of the body, in
  // order; everything else of its head is dropped.
  for (const node of [...parsed.head.querySelectorAll('style, script')].reverse()) {
    parsed.body.prepend(node);
  }
  // No refresh, no second policy, no base URL: the app's head is the only head.
  for (const node of [...parsed.body.querySelectorAll('meta, base, link, iframe, object, embed')]) {
    node.remove();
  }
  // A `<script src>` would be blocked anyway; dropping it keeps the frame from even asking.
  for (const script of [...parsed.body.querySelectorAll('script[src]')]) script.remove();

  const hashes = new Set<string>([await sha256(FRAME_SCRIPT)]);
  let handlers = false;
  for (const script of parsed.body.querySelectorAll('script')) {
    hashes.add(await sha256(script.textContent ?? ''));
  }
  for (const element of parsed.body.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        hashes.add(await sha256(attribute.value));
        handlers = true;
      }
    }
  }
  const tags: Array<string> = [];
  for (const id of new Set(libraries)) {
    const library = demoLibrary(id);
    if (library === undefined) continue;
    hashes.add(`'${library.integrity}'`);
    tags.push(
      `<script src="${escapeAttr(library.url)}" integrity="${library.integrity}" crossorigin="anonymous"></script>`,
    );
  }
  const scriptSrc = [...hashes, ...(handlers ? ["'unsafe-hashes'"] : [])].join(' ');
  const csp = [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
  ].join('; ');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${rootStyle(vars)} body { margin: 8px; font-family: system-ui, sans-serif; }</style>`,
    `<script>${FRAME_SCRIPT}</script>`,
    ...tags,
    `</head><body>${parsed.body.innerHTML}</body></html>`,
  ].join('');
};
