// Extraction pipeline (plan luyen-tap-graph.md A3, A4): a finished session becomes one batch of
// knowledge events. Three model calls with structured output, fixed in the step 1 spike:
//   1. extractor: propositions and edges from the transcript;
//   2. auditor: keep / revise / split / drop each proposition, keep / fix / drop each edge;
//   3. merge: each new proposition against its K closest existing propositions (`selectCandidates`
//      on the slice the caller sent): same (adds a source to the old one) or new.
// Merge is skipped when no proposition has a candidate. The batch ends with `SessionExtracted`.
// The caller writes `ExtractionStarted` before, and fits the batch to the current graph
// (`fitKnowledgeBatch`) when writing it: this code only sees the slice, not the whole graph.
//
// Nothing from the model is trusted: ids that are not in the slice, keys that do not exist and
// relations outside the closed set are dropped here, so the batch always refers to real things.
import { Clock, Data, Effect, Result, Schema, Stream } from 'effect';
import { AiPort, OutputInvalid } from '@kd-learn/ai/port';
import type { AiError, ModelRef } from '@kd-learn/ai/port';
import {
  Relation,
  maxPropositionLength,
  projectSession,
  selectCandidates,
  type EventLog,
  type GraphSlice,
  type KnowledgeEvent,
  type ResolvedProfile,
  type Session,
  type SliceProposition,
} from '@kd-learn/core';
import { failureOf, modelName, type FailureInfo } from './turn.ts';

export interface ExtractionParams {
  /** Event log of the session to extract. */
  readonly log: EventLog;
  /** Tier 1 slice of the owner's graph (`selectSessionSlice`), as the caller chose it. */
  readonly slice: GraphSlice;
  /** Profile active when the extraction runs (A2), already resolved. */
  readonly profile: ResolvedProfile;
  readonly model: ModelRef;
  /** The id written in `ExtractionStarted`. */
  readonly extractionId: string;
  readonly newId: () => string;
  /** Output cap of each call (A8: demo has its own cap for this role). */
  readonly maxOutputTokens?: number;
}

export interface ExtractionUsage {
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ExtractionResult {
  /** Graph events, then `SessionExtracted`. Fit them to the graph before writing. */
  readonly events: ReadonlyArray<KnowledgeEvent>;
  readonly usage: ExtractionUsage;
  /** What the pipeline left out from the model's answers, for logs and tests. */
  readonly dropped: ReadonlyArray<string>;
}

/** The session cannot be extracted (log does not project, nothing was taught yet). */
export class InvalidExtraction extends Data.TaggedError('InvalidExtraction')<{
  readonly message: string;
}> {}

/** A model call failed. `failure` is ready for `ExtractionFailed` (the key is removed). */
export class ExtractionModelFailed extends Data.TaggedError('ExtractionModelFailed')<{
  readonly step: 'extractor' | 'auditor' | 'merge';
  readonly failure: FailureInfo;
  /** Usage of the calls that did finish, to settle a demo reservation. */
  readonly usage: ExtractionUsage;
}> {}

export type ExtractionError = InvalidExtraction | ExtractionModelFailed;

/** Longest topic a proposition carries (`PropositionAdded.topic`). */
const maxTopicLength = 200;

// Output schemas. `Schema.Finite`, not `Schema.Number`, for the JSON Schema sent to providers.
const Key = Schema.String;
const ProposedEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  relation: Relation,
  label: Schema.String,
});

export const Extracted = Schema.Struct({
  propositions: Schema.Array(
    Schema.Struct({ key: Key, text: Schema.String, stepId: Schema.String }),
  ),
  edges: Schema.Array(ProposedEdge),
});

export const Audited = Schema.Struct({
  propositions: Schema.Array(
    Schema.Struct({
      key: Key,
      verdict: Schema.Literals(['keep', 'revise', 'split', 'drop']),
      /** Final sentence for keep / revise; empty for split / drop. */
      text: Schema.String,
      /** Sentences of a split, one idea each; empty otherwise. */
      parts: Schema.Array(Schema.String),
      reason: Schema.String,
    }),
  ),
  edges: Schema.Array(
    Schema.Struct({
      index: Schema.Finite,
      verdict: Schema.Literals(['keep', 'fix', 'drop']),
      from: Schema.String,
      to: Schema.String,
      relation: Relation,
      reason: Schema.String,
    }),
  ),
});

export const Merged = Schema.Struct({
  decisions: Schema.Array(
    Schema.Struct({
      key: Key,
      action: Schema.Literals(['new', 'same']),
      existingId: Schema.String,
      reason: Schema.String,
    }),
  ),
  edges: Schema.Array(ProposedEdge),
});

/** The session as the model reads it: plan, assessment, the main thread of completed turns. */
export const transcript = (session: Session, log: EventLog): string => {
  const completed = new Set(
    session.turns.filter((turn) => turn.status === 'completed').map((turn) => turn.turnId),
  );
  const lines: Array<string> = [`Topic: ${session.topic}`];
  for (const event of log) {
    switch (event._tag) {
      case 'AssessmentRecorded':
        lines.push(`Assessment (${event.level}): ${event.summary}\nGaps: ${event.gaps.join('; ')}`);
        break;
      case 'PlanCreated':
        lines.push(
          'Plan:\n' + event.plan.nodes.map((n) => `- [${n.id}] ${n.title}: ${n.goal}`).join('\n'),
        );
        break;
      case 'TurnStarted':
        if (completed.has(event.turnId) && event.input !== '')
          lines.push(`LEARNER: ${event.input}`);
        break;
      case 'MessageAppended':
        if (completed.has(event.turnId))
          lines.push(`${event.agent.toUpperCase()}: ${event.content}`);
        break;
      case 'StepCompleted':
        lines.push(`(step ${event.stepId} completed)`);
        break;
      case 'StepSkipped':
        lines.push(`(step ${event.stepId} skipped by the learner)`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n\n');
};

const languageLine = (language: string) =>
  `Write every proposition and label in the language with BCP 47 tag "${language}".`;

interface Proposal {
  readonly key: string;
  readonly text: string;
  readonly stepId: string | undefined;
}

interface ProposalEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: Relation;
  readonly label: string;
}

/** Runs the three calls and builds the batch. */
export const runExtraction = (
  params: ExtractionParams,
): Effect.Effect<ExtractionResult, ExtractionError, AiPort> =>
  Effect.gen(function* () {
    const projected = projectSession(params.log);
    if (Result.isFailure(projected)) {
      return yield* new InvalidExtraction({ message: projected.failure.message });
    }
    const session = projected.success;
    if (!session.turns.some((turn) => turn.status === 'completed')) {
      return yield* new InvalidExtraction({ message: 'The session has no completed turn yet.' });
    }
    const ai = yield* AiPort;
    const { model, profile, slice } = params;
    const usage = { model: modelName(model), calls: 0, inputTokens: 0, outputTokens: 0 };
    const dropped: Array<string> = [];
    const text = transcript(session, params.log);
    const stepIds = new Set(session.plan?.nodes.map((node) => node.id) ?? []);
    const language = session.profile.language;
    const at = yield* Clock.currentTimeMillis;

    const call = <A>(
      step: 'extractor' | 'auditor' | 'merge',
      system: string,
      user: string,
      output: Schema.Codec<A, unknown>,
    ) =>
      Effect.gen(function* () {
        let value: A | undefined;
        usage.calls += 1;
        yield* ai
          .runTurn({
            model,
            system,
            messages: [{ role: 'user', content: user }],
            output,
            maxSteps: 1,
            ...(params.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: params.maxOutputTokens }),
          })
          .pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event._tag === 'StructuredResult') value = event.value;
                if (event._tag === 'Usage') {
                  usage.inputTokens += event.inputTokens;
                  usage.outputTokens += event.outputTokens;
                }
              }),
            ),
          );
        if (value === undefined) {
          return yield* Effect.fail<AiError>(
            new OutputInvalid({ message: 'The model returned no structured result.', raw: '' }),
          );
        }
        return value;
      }).pipe(
        Effect.mapError(
          (error: AiError) =>
            new ExtractionModelFailed({
              step,
              failure: failureOf(error, model),
              usage: { ...usage },
            }),
        ),
      );

    // 1. Extractor.
    const extracted = yield* call(
      'extractor',
      profile.prompts.extractor,
      `${languageLine(language)}\nPlan step ids: ${[...stepIds].join(', ') || '(none)'}.\n\nSESSION:\n\n${text}`,
      Extracted,
    );
    const proposals = new Map<string, Proposal>();
    for (const p of extracted.propositions) {
      const clean = p.text.trim();
      if (
        p.key === '' ||
        clean === '' ||
        proposals.has(p.key) ||
        clean.length > maxPropositionLength
      ) {
        dropped.push(`extractor proposition "${p.key}": empty, too long or repeated key`);
        continue;
      }
      proposals.set(p.key, {
        key: p.key,
        text: clean,
        stepId: stepIds.has(p.stepId) ? p.stepId : undefined,
      });
    }
    const proposedEdges: Array<ProposalEdge> = extracted.edges.filter((edge) => {
      const ok = proposals.has(edge.from) && proposals.has(edge.to) && edge.from !== edge.to;
      if (!ok) dropped.push(`extractor edge ${edge.from} -> ${edge.to}: unknown key`);
      return ok;
    });
    if (proposals.size === 0) return finish([], usage, dropped);

    // 2. Auditor: propositions and edges in one call.
    const audited = yield* call(
      'auditor',
      profile.prompts.auditor,
      [
        languageLine(language),
        'Answer for every proposition (by key) and every edge (by index).',
        'For split, put one sentence per idea in parts and leave text empty; otherwise parts is empty.',
        'For edges, from / to / relation matter only for fix (the corrected values); leave from and to empty otherwise.',
        `SESSION:\n\n${text}`,
        `PROPOSITIONS:\n${[...proposals.values()].map((p) => `- ${p.key} [${p.stepId ?? '-'}]: ${p.text}`).join('\n')}`,
        `EDGES:\n${proposedEdges.map((e, i) => `${i}. ${e.from} ${e.relation} ${e.to} (${e.label})`).join('\n') || '(none)'}`,
      ].join('\n\n'),
      Audited,
    );
    const kept = new Map<string, Proposal>();
    const verdictOf = new Map(audited.propositions.map((v) => [v.key, v]));
    for (const proposal of proposals.values()) {
      const verdict = verdictOf.get(proposal.key);
      // The auditor saw every proposition; one it skipped is not trusted.
      if (verdict === undefined || verdict.verdict === 'drop') {
        dropped.push(`auditor dropped "${proposal.key}"${verdict ? `: ${verdict.reason}` : ''}`);
        continue;
      }
      if (verdict.verdict === 'split') {
        verdict.parts
          .map((part) => part.trim())
          .filter((part) => part !== '' && part.length <= maxPropositionLength)
          .forEach((part, i) =>
            kept.set(`${proposal.key}#${i + 1}`, {
              ...proposal,
              key: `${proposal.key}#${i + 1}`,
              text: part,
            }),
          );
        continue;
      }
      const final = verdict.verdict === 'revise' ? verdict.text.trim() : proposal.text;
      const textOk = final !== '' && final.length <= maxPropositionLength;
      kept.set(proposal.key, { ...proposal, text: textOk ? final : proposal.text });
    }
    const edgeVerdicts = new Map(audited.edges.map((v) => [v.index, v]));
    const auditedEdges: Array<ProposalEdge> = [];
    proposedEdges.forEach((edge, index) => {
      const verdict = edgeVerdicts.get(index);
      if (verdict?.verdict === 'drop') return;
      // Not mentioned: keep as proposed (the extractor's edges are mostly right, step 1).
      const final =
        verdict?.verdict === 'fix' && verdict.from !== '' && verdict.to !== ''
          ? { ...edge, from: verdict.from, to: verdict.to, relation: verdict.relation }
          : edge;
      // Edges of a split proposition, or fixed to an unknown key, are left out.
      if (!kept.has(final.from) || !kept.has(final.to) || final.from === final.to) {
        dropped.push(`edge ${final.from} -> ${final.to}: end not kept`);
        return;
      }
      auditedEdges.push(final);
    });
    if (kept.size === 0) return finish([], usage, dropped);

    // 3. Merge, only for propositions that have candidates.
    const candidatesOf = new Map<string, GraphSlice>();
    for (const proposal of kept.values()) {
      const candidates = selectCandidates(slice, proposal.text);
      if (candidates.length > 0) candidatesOf.set(proposal.key, candidates);
    }
    const sameAs = new Map<string, string>();
    const mergeEdges: Array<ProposalEdge> = [];
    if (candidatesOf.size > 0) {
      const listed = (c: SliceProposition) => `  - id ${c.propositionId}: ${c.text}`;
      const merged = yield* call(
        'merge',
        profile.prompts.merge,
        [
          languageLine(language),
          'Answer for every NEW proposition by key.',
          [...candidatesOf]
            .map(
              ([key, candidates]) =>
                `NEW ${key}: ${kept.get(key)!.text}\nCANDIDATES:\n${candidates.map(listed).join('\n')}`,
            )
            .join('\n\n'),
        ].join('\n\n'),
        Merged,
      );
      for (const decision of merged.decisions) {
        if (decision.action !== 'same') continue;
        const allowed = candidatesOf.get(decision.key);
        if (allowed?.some((c) => c.propositionId === decision.existingId)) {
          sameAs.set(decision.key, decision.existingId);
        } else {
          dropped.push(`merge "${decision.key}": "${decision.existingId}" is not a candidate`);
        }
      }
      for (const edge of merged.edges) {
        // One end is a new key, the other a candidate of that key.
        const [key, id] = kept.has(edge.from) ? [edge.from, edge.to] : [edge.to, edge.from];
        if (!kept.has(key) || !candidatesOf.get(key)?.some((c) => c.propositionId === id)) {
          dropped.push(
            `merge edge ${edge.from} -> ${edge.to}: not a key and one of its candidates`,
          );
          continue;
        }
        mergeEdges.push(edge);
      }
    }

    // Build the batch.
    const topic = [...session.topic].slice(0, maxTopicLength).join('');
    const idOf = new Map<string, string>();
    const events: Array<KnowledgeEvent> = [];
    for (const proposal of kept.values()) {
      const source = {
        sessionId: session.sessionId,
        ...(proposal.stepId === undefined ? {} : { stepId: proposal.stepId }),
      };
      const existing = sameAs.get(proposal.key);
      if (existing !== undefined) {
        idOf.set(proposal.key, existing);
        events.push({
          _tag: 'PropositionSourced',
          id: params.newId(),
          at,
          propositionId: existing,
          source,
        });
      } else {
        const propositionId = params.newId();
        idOf.set(proposal.key, propositionId);
        events.push({
          _tag: 'PropositionAdded',
          id: params.newId(),
          at,
          propositionId,
          text: proposal.text,
          topic,
          source,
        });
      }
    }
    const resolve = (end: string) => idOf.get(end) ?? end;
    const seen = new Set<string>();
    for (const edge of [...auditedEdges, ...mergeEdges]) {
      const from = resolve(edge.from);
      const to = resolve(edge.to);
      // Two keys merged into the same old proposition, or a repeat inside the batch.
      const key =
        edge.relation === 'contrastsWith'
          ? [edge.relation, ...[from, to].sort()].join('|')
          : `${edge.relation}|${from}|${to}`;
      if (from === to || seen.has(key)) continue;
      seen.add(key);
      events.push({
        _tag: 'EdgeAdded',
        id: params.newId(),
        at,
        edgeId: params.newId(),
        from,
        to,
        relation: edge.relation,
        label: edge.label.slice(0, 200),
      });
    }
    return finish(events, usage, dropped);

    function finish(
      graphEvents: ReadonlyArray<KnowledgeEvent>,
      total: ExtractionUsage,
      left: ReadonlyArray<string>,
    ): ExtractionResult {
      return {
        events: [
          ...graphEvents,
          {
            _tag: 'SessionExtracted',
            id: params.newId(),
            at,
            sessionId: session.sessionId,
            extractionId: params.extractionId,
            profileId: profile.id,
            usage: { ...total },
          },
        ],
        usage: { ...total },
        dropped: left,
      };
    }
  });
