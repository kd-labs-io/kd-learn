// What the practice screen needs, whoever keeps the practice: the local knowledge log (guest and
// demo) or the server (account). Same pattern as `ProfileSource` (profile/source.ts). Both modes
// show the same `PracticeView`, built by the same helpers (`practiceView` in @kd-learn/api), so an
// answer key is hidden until graded in both.
import { practiceView, type PracticeView } from '@kd-learn/api';
import type { ExerciseAnswer, ExerciseTypeId } from '@kd-learn/core';
import { getLocale } from '@kd-learn/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Result } from 'effect';
import { errorText, keys, useAccountApi } from '../account/api';
import { localModeNow } from '../account/auth';
import { modelChoiceOf } from '../learn/model';
import { apiBaseUrl } from '../learn/hooks';
import { getStorage, useGuestSettings, useKnowledge } from '../storage';
import { makeGuestPractice, openPractice, PRACTICE_SIZE } from './guest-practice';

export type PracticeScreenView =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      /** Active propositions of the graph: 0 shows the empty state. */
      readonly propositionCount: number;
      /** The open practice to resume, if any. */
      readonly practice: PracticeView | undefined;
      /** Guest without a model key: practice cannot start. */
      readonly needsKey: boolean;
    };

/** Every action rejects with an `Error` whose message can be shown. */
export interface PracticeSource {
  readonly view: PracticeScreenView;
  start(types: ReadonlyArray<ExerciseTypeId>): Promise<void>;
  /** Submits and grades. A failed grade keeps the answer: `grade` retries it. */
  answer(exerciseId: string, answer: ExerciseAnswer): Promise<void>;
  grade(exerciseId: string): Promise<void>;
  end(practiceId: string): Promise<void>;
}

/** The guest practice of this tab, at module level so a call outlives the screen that made it. */
export const guestPractice = makeGuestPractice({
  storage: getStorage,
  demo: () => localModeNow() === 'demo',
  language: getLocale,
  baseUrl: apiBaseUrl,
});

/** Guest and demo: the practice in the local knowledge log, re-read on every knowledge change. */
export function useGuestPracticeSource(demo: boolean): PracticeSource {
  const knowledge = useKnowledge();
  const settings = useGuestSettings();
  let view: PracticeScreenView;
  if (knowledge.status === 'loading' || settings.status === 'loading') {
    view = { status: 'loading' };
  } else if (knowledge.status === 'error') {
    view = { status: 'error', message: knowledge.error.message };
  } else if (settings.status === 'error') {
    view = { status: 'error', message: settings.error.message };
  } else if (Result.isFailure(knowledge.data.graph)) {
    view = { status: 'error', message: knowledge.data.graph.failure.message };
  } else {
    const graph = knowledge.data.graph.success;
    const open = openPractice(graph);
    view = {
      status: 'ready',
      propositionCount: Object.keys(graph.propositions).length,
      practice: open === undefined ? undefined : practiceView(graph, open.practiceId),
      needsKey: !demo && modelChoiceOf(settings.data) === undefined,
    };
  }
  return {
    view,
    start: async (types) => void (await guestPractice.start(types)),
    answer: guestPractice.answer,
    grade: guestPractice.grade,
    end: guestPractice.end,
  };
}

/** Account: `GET /api/account/practice` through Query; every action refetches it. */
export function useAccountPracticeSource(token: string): PracticeSource {
  const { call } = useAccountApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.practices(token),
    queryFn: () => call((api) => api.practices()),
  });
  /** Runs an action, then refetches: the server may have stored part of it (an answer). */
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      throw new Error(errorText(error), { cause: error });
    } finally {
      await queryClient.invalidateQueries({ queryKey: keys.practices(token) });
    }
  };
  const view: PracticeScreenView = query.isPending
    ? { status: 'loading' }
    : query.isError
      ? { status: 'error', message: errorText(query.error) }
      : {
          status: 'ready',
          propositionCount: query.data.propositionCount,
          practice: query.data.practices.at(-1),
          needsKey: false,
        };
  return {
    view,
    start: (types) =>
      act(() => call((api) => api.startPractice({ count: PRACTICE_SIZE, types: [...types] }))),
    answer: (exerciseId, answer) =>
      act(() => call((api) => api.answerExercise(exerciseId, answer))),
    grade: (exerciseId) => act(() => call((api) => api.gradeExercise(exerciseId))),
    end: (practiceId) => act(() => call((api) => api.endPractice(practiceId))),
  };
}
