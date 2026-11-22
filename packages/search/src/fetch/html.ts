// HTML to readable text for fetched pages (plan nguon-hoc.md A5). Not a sanitiser: the text goes
// into a prompt as untrusted data, never into a page. Scripts, styles and markup are dropped.

const named: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return named[body.toLowerCase()] ?? match;
  });

const block =
  /<\/?(p|div|section|article|main|header|footer|aside|nav|li|ul|ol|table|tr|td|th|h[1-6]|br|hr|pre|blockquote|figure|figcaption|dd|dt|dl)\b[^>]*>/gi;

/** The `<title>` of a page, if any. */
export const htmlTitle = (html: string): string | undefined => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title =
    match?.[1] === undefined ? '' : decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title : undefined;
};

/** Readable text of an HTML page: paragraphs separated by blank lines. */
export const htmlToText = (html: string): string => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|template|svg|iframe|head|form|button|select)\b[\s\S]*?<\/\1>/gi,
      ' ',
    )
    .replace(block, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
};
