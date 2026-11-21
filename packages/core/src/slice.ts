// Graph slice sent with a request (plan luyen-tap-graph.md A4). Merge only needs the propositions
// close to a session, so the graph is cut in two tiers, both measured lexically (set of words
// without stopwords, binary cosine; no embedding):
//   1. session slice: at most 200 propositions closest to the session content, cut by bytes;
//   2. candidates: for each new proposition, the K = 5 closest propositions of the slice.
// The tokeniser follows the step 1 spike (where K = 5 was measured), widened from ASCII to every
// Unicode letter so Vietnamese works. Deterministic: guest and server must pick the same slice.
import { Schema } from 'effect';
import type { KnowledgeGraph } from './knowledge.ts';
import { PropositionId } from './knowledge-event.ts';
import type { Session } from './session.ts';

/** One proposition as a slice carries it: what merge reads. */
export const SliceProposition = Schema.Struct({
  propositionId: PropositionId,
  text: Schema.String,
  topic: Schema.String,
});
export type SliceProposition = typeof SliceProposition.Type;

export const GraphSlice = Schema.Array(SliceProposition);
export type GraphSlice = typeof GraphSlice.Type;

export const defaultSliceLimit = 200;
/** Default byte budget of a slice (UTF-8 of its JSON): well under the 256 KiB demo request limit. */
export const defaultSliceBytes = 96 * 1024;
export const defaultCandidateCount = 5;

// English list from the spike, plus common Vietnamese function words (single syllables, since
// Vietnamese words are split on spaces like English ones).
const stopwords = new Set(
  [
    'a an the of to in on for and or is are be by as it its this that with from at so than then',
    'when if each every one two not no can may has have do does which into only all any more less',
    'most about',
    'là và của các những một có không được cho với trong này đó thì mà khi nếu để ra vào từ',
    'cũng như bị đã đang sẽ rất hơn nhất nhiều ít mỗi hay hoặc nên vì do theo trên dưới về lại',
    'còn chỉ đều nó họ ta ai gì nào đây kia ấy thế vậy rằng',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Words of `text` that carry meaning: NFC, lower case, split on anything that is not a letter or a
 * digit, words of one character and stopwords dropped, a plural `s` / `es` cut (as in the spike).
 */
export const tokenize = (text: string): ReadonlySet<string> => {
  const words = new Set<string>();
  for (const raw of text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if ([...raw].length <= 1 || stopwords.has(raw)) continue;
    words.add(raw.replace(/(es|s)$/, ''));
  }
  return words;
};

/** Binary cosine of two word sets: shared words over the geometric mean of the sizes. */
export const lexicalSimilarity = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.sqrt(a.size * b.size);
};

/** UTF-8 length of a string, without TextEncoder (core imports no platform API). */
const utf8Length = (text: string): number => {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/** Ranks `items` by similarity to `query`, best first, ties by id; drops those sharing no word. */
const rank = (
  query: ReadonlySet<string>,
  items: ReadonlyArray<SliceProposition>,
): ReadonlyArray<SliceProposition> =>
  items
    .map((item) => ({ item, score: lexicalSimilarity(query, tokenize(item.text)) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.item.propositionId < b.item.propositionId
          ? -1
          : a.item.propositionId > b.item.propositionId
            ? 1
            : 0),
    )
    .map(({ item }) => item);

/**
 * What a session is about, for tier 1: topic, title and goal of every plan step, the assessment.
 * The turns are left out on purpose: they are long and repeat the plan.
 */
export const sessionQueryText = (session: Session): string =>
  [
    session.topic,
    ...(session.plan?.nodes.flatMap((node) => [node.title, node.goal]) ?? []),
    session.assessment?.summary ?? '',
    ...(session.assessment?.gaps ?? []),
  ].join('\n');

/**
 * Tier 1: the active propositions closest to `queryText`, at most `limit` of them and at most
 * `maxBytes` of JSON (the slice stops at the first proposition that would not fit).
 */
export const selectSessionSlice = (
  graph: KnowledgeGraph,
  queryText: string,
  options: { readonly limit?: number; readonly maxBytes?: number } = {},
): GraphSlice => {
  const { limit = defaultSliceLimit, maxBytes = defaultSliceBytes } = options;
  const all = Object.values(graph.propositions).map(
    ({ propositionId, text, topic }): SliceProposition => ({ propositionId, text, topic }),
  );
  const slice: Array<SliceProposition> = [];
  // `[` and `]`, then one comma between items.
  let bytes = 2;
  for (const item of rank(tokenize(queryText), all)) {
    if (slice.length >= limit) break;
    const size = utf8Length(JSON.stringify(item)) + (slice.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) break;
    slice.push(item);
    bytes += size;
  }
  return slice;
};

/** Tier 2: the `k` propositions of the slice closest to one new proposition. */
export const selectCandidates = (
  slice: GraphSlice,
  text: string,
  k: number = defaultCandidateCount,
): GraphSlice => rank(tokenize(text), slice).slice(0, k);
