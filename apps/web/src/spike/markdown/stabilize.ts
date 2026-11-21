// SPIKE (phase 1 step 6): hold back syntax that is still incomplete while streaming, so the
// renderer never shows raw `$`, `$$` or half a table. Pure string function, no renderer
// dependency. Only the unfinished tail is cut; the cut part comes back on the next chunk.

const isFence = (line: string) => /^ {0,3}(```|~~~)/.test(line);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** Index in `tail` of an inline `$` opener that has no closer yet, or -1. */
function unclosedInlineMath(tail: string): number {
  let i = 0;
  while (i < tail.length) {
    const c = tail[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (tail[i + n] === '`') n++;
      const close = tail.indexOf('`'.repeat(n), i + n);
      if (close === -1) return -1; // unclosed code span: not math, leave alone
      i = close + n;
      continue;
    }
    if (c === '$') {
      const next = tail[i + 1];
      if (next === undefined) return i;
      if (next === '$') {
        const close = tail.indexOf('$$', i + 2);
        if (close === -1) return i;
        i = close + 2;
        continue;
      }
      if (isSpace(next)) {
        i += 1;
        continue;
      }
      let found = -1;
      for (let j = i + 1; j < tail.length; j++) {
        if (tail[j] === '\\') {
          j++;
          continue;
        }
        if (tail[j] === '$' && !isSpace(tail[j - 1]) && !/\d/.test(tail[j + 1] ?? '')) {
          found = j;
          break;
        }
      }
      if (found === -1) {
        // Another unescaped `$` that cannot close (currency like "$5 or $10"): keep both literal.
        let later = -1;
        for (let j = i + 1; j < tail.length; j++) {
          if (tail[j] === '\\') j++;
          else if (tail[j] === '$') {
            later = j;
            break;
          }
        }
        if (later === -1) return i;
        i = later;
        continue;
      }
      i = found + 1;
      continue;
    }
    i++;
  }
  return -1;
}

export function stabilize(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  let mathStart = -1; // line index of an open `$$` block
  let paraStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (mathStart === -1 && isFence(line)) {
      inFence = !inFence;
      paraStart = i + 1;
      continue;
    }
    if (inFence) continue;
    if (mathStart !== -1) {
      if (line.trimEnd().endsWith('$$')) {
        mathStart = -1;
        paraStart = i + 1;
      }
      continue;
    }
    const t = line.trim();
    if (t.startsWith('$$')) {
      if (t.length >= 4 && t.endsWith('$$')) paraStart = i + 1;
      else mathStart = i;
      continue;
    }
    if (t === '') paraStart = i + 1;
  }
  if (inFence) return text; // an unclosed code fence renders fine as code
  if (mathStart !== -1) return lines.slice(0, mathStart).join('\n');

  // Unfinished inline math in the last paragraph.
  const tail = lines.slice(paraStart).join('\n');
  const cut = unclosedInlineMath(tail);
  let result = cut === -1 ? text : text.slice(0, text.length - tail.length) + tail.slice(0, cut);

  // Table whose delimiter row is not complete yet.
  const rows = result.replace(/\n+$/, '').split('\n');
  const last = rows.at(-1) ?? '';
  const prev = rows.at(-2) ?? '';
  const cells = (s: string) =>
    s
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|').length;
  const delimiterish = /^[|:\- ]+$/.test(last) && last.includes('-');
  if (delimiterish && prev.trim().startsWith('|') && cells(last) < cells(prev)) {
    result = rows.slice(0, -2).join('\n');
  } else if (last.trim().startsWith('|') && !prev.trim().startsWith('|')) {
    // A lone pipe row may still turn into a table header.
    result = rows.slice(0, -1).join('\n');
  }
  return result;
}
