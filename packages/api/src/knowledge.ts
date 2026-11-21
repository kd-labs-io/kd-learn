// The knowledge graph as a screen shows it (phase 3 A9): active propositions with their mastery,
// and active edges. Nothing about exercises, so an account can read it without seeing answers.
// Guest mode builds the same view from its local log, so both modes render one shape.
import { Schema } from 'effect';
import { PropositionSource, Relation, type KnowledgeGraph } from '@kd-learn/core';

export const KNOWLEDGE_PATH = '/api/account/knowledge';

export const PropositionView = Schema.Struct({
  propositionId: Schema.NonEmptyString,
  text: Schema.String,
  topic: Schema.String,
  sources: Schema.Array(PropositionSource),
  addedAt: Schema.Number,
  updatedAt: Schema.Number,
  /** Present once the proposition was graded at least once (A7). */
  mastery: Schema.optionalKey(
    Schema.Struct({
      box: Schema.Number,
      attempts: Schema.Number,
      lastScore: Schema.Number,
      dueAt: Schema.Number,
    }),
  ),
});
export type PropositionView = typeof PropositionView.Type;

export const EdgeView = Schema.Struct({
  edgeId: Schema.NonEmptyString,
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
  relation: Relation,
  label: Schema.String,
});
export type EdgeView = typeof EdgeView.Type;

/** `GET /api/account/knowledge`, and the answer of a retire. Newest propositions first. */
export const GraphView = Schema.Struct({
  propositions: Schema.Array(PropositionView),
  edges: Schema.Array(EdgeView),
});
export type GraphView = typeof GraphView.Type;

/** The screen's view of a projected graph. Pure. */
export const toGraphView = (graph: KnowledgeGraph): GraphView => ({
  propositions: Object.values(graph.propositions)
    .map((p): PropositionView => {
      const mastery = graph.mastery[p.propositionId];
      return {
        propositionId: p.propositionId,
        text: p.text,
        topic: p.topic,
        sources: p.sources,
        addedAt: p.addedAt,
        updatedAt: p.updatedAt,
        ...(mastery === undefined
          ? {}
          : {
              mastery: {
                box: mastery.box,
                attempts: mastery.attempts,
                lastScore: mastery.lastScore,
                dueAt: mastery.dueAt,
              },
            }),
      };
    })
    .sort((a, b) => b.addedAt - a.addedAt || (a.propositionId < b.propositionId ? -1 : 1)),
  edges: Object.values(graph.edges).map(({ edgeId, from, to, relation, label }) => ({
    edgeId,
    from,
    to,
    relation,
    label,
  })),
});
