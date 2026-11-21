// Practice screen (plan luyen-tap-graph.md A6, A7, phase 3 step 10). One practice at a time: the
// open one is resumed (after a reload too, since it lives in the knowledge log), otherwise the
// learner starts one. Each exercise shows its renderer, then the grade, the feedback, the right
// answer and the mastery of what it tested.
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { ExerciseView, PracticeView } from '@kd-learn/api';
import { masteryBoxes, type ExerciseAnswer } from '@kd-learn/core';
import { getLocaleTag, m } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AppHeader } from '../app/AppHeader';
import { ExerciseBody, ExerciseSolution, exerciseRenderers, renderedTypes } from './renderers';
import type { PracticeSource } from './source';

const formatDay = (epochMs: number) =>
  new Intl.DateTimeFormat(getLocaleTag(), { dateStyle: 'medium' }).format(epochMs);

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const resultLabel = (score: number) =>
  score >= 0.75
    ? m.practice_result_correct()
    : score >= 0.5
      ? m.practice_result_partial()
      : m.practice_result_incorrect();

const resultStatus = (score: number) =>
  score >= 0.75 ? 'success' : score >= 0.5 ? 'warning' : 'error';

function Grade({ exercise }: { readonly exercise: ExerciseView }) {
  const grade = exercise.grade!;
  return (
    <VStack gap={2}>
      <Banner
        status={resultStatus(grade.score)}
        title={resultLabel(grade.score)}
        description={m.practice_score({ score: Math.round(grade.score * 100) })}
        data-testid="exercise-grade"
      />
      {grade.feedback === '' ? null : <Text data-testid="exercise-feedback">{grade.feedback}</Text>}
      <ExerciseSolution exercise={exercise} />
      {(exercise.mastery ?? []).map((mastery) => (
        <Text key={mastery.propositionId} type="supporting" data-testid="exercise-mastery">
          {m.practice_mastery({
            box: mastery.box,
            max: masteryBoxes,
            date: formatDay(mastery.dueAt),
          })}
        </Text>
      ))}
    </VStack>
  );
}

function Exercise({
  exercise,
  n,
  total,
  source,
}: {
  readonly exercise: ExerciseView;
  readonly n: number;
  readonly total: number;
  readonly source: PracticeSource;
}) {
  const [draft, setDraft] = useState<ExerciseAnswer | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
    } catch (cause) {
      setError(reasonOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const answered = exercise.answer !== undefined;
  return (
    <Card data-testid="exercise" data-type={exercise.type}>
      <VStack gap={4}>
        <HStack gap={2} justify="between" vAlign="center" wrap="wrap">
          <Heading level={3}>{m.practice_exercise_heading({ n, total })}</Heading>
          <Text type="supporting">{exerciseRenderers[exercise.type].label()}</Text>
        </HStack>
        <ExerciseBody exercise={exercise} onDraft={setDraft} />
        {answered ? null : (
          <Button
            label={m.practice_submit()}
            variant="primary"
            isLoading={busy}
            // An ordering is an answer as shown, before any move.
            isDisabled={draft === undefined && exercise.content.type !== 'orderChain'}
            onClick={() =>
              void act(() =>
                source.answer(
                  exercise.exerciseId,
                  draft ??
                    (exercise.content.type === 'orderChain'
                      ? {
                          type: 'orderChain',
                          order: exercise.content.items.map((item) => item.propositionId),
                        }
                      : (undefined as never)),
                ),
              )
            }
            data-testid="exercise-submit"
          />
        )}
        {exercise.grade !== undefined ? <Grade exercise={exercise} /> : null}
        {answered && exercise.grade === undefined ? (
          busy ? (
            <Spinner size="sm" label={m.practice_grading()} />
          ) : (
            <Banner
              status="info"
              title={m.practice_not_graded()}
              endContent={
                <Button
                  label={m.practice_grade_again()}
                  onClick={() => void act(() => source.grade(exercise.exerciseId))}
                  data-testid="exercise-grade-again"
                />
              }
              data-testid="exercise-not-graded"
            />
          )
        ) : null}
        {error === undefined ? null : (
          <Banner
            status="error"
            title={m.practice_failed({ reason: error })}
            data-testid="exercise-error"
          />
        )}
      </VStack>
    </Card>
  );
}

function OpenPractice({
  practice,
  source,
}: {
  readonly practice: PracticeView;
  readonly source: PracticeSource;
}) {
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const total = practice.exercises.length;
  const graded = practice.exercises.filter((e) => e.grade !== undefined).length;
  const end = async () => {
    setEnding(true);
    setError(undefined);
    try {
      await source.end(practice.practiceId);
    } catch (cause) {
      setError(reasonOf(cause));
    } finally {
      setEnding(false);
    }
  };
  return (
    <VStack gap={4} data-testid="practice" data-practice-id={practice.practiceId}>
      <Text type="supporting" data-testid="practice-progress">
        {m.practice_progress({ graded, total })}
      </Text>
      {practice.exercises.map((exercise, index) => (
        <Exercise
          key={exercise.exerciseId}
          exercise={exercise}
          n={index + 1}
          total={total}
          source={source}
        />
      ))}
      {graded === total ? (
        <Banner
          status="success"
          title={m.practice_done_title()}
          description={m.practice_done_body()}
          data-testid="practice-done"
        />
      ) : null}
      <Button
        label={m.practice_end()}
        variant={graded === total ? 'primary' : 'secondary'}
        isLoading={ending}
        onClick={() => void end()}
        data-testid="practice-end"
      />
      {error === undefined ? null : (
        <Banner status="error" title={m.practice_failed({ reason: error })} />
      )}
    </VStack>
  );
}

export function PracticeScreen({ source }: { readonly source: PracticeSource }) {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const { view } = source;

  const start = async () => {
    setStarting(true);
    setError(undefined);
    try {
      await source.start(renderedTypes);
    } catch (cause) {
      setError(reasonOf(cause));
    } finally {
      setStarting(false);
    }
  };

  let body;
  if (view.status === 'loading') {
    body = <Spinner label={m.learn_loading()} />;
  } else if (view.status === 'error') {
    body = <Banner status="error" title={m.practice_failed({ reason: view.message })} />;
  } else if (view.practice !== undefined) {
    body = <OpenPractice practice={view.practice} source={source} />;
  } else if (view.propositionCount === 0) {
    body = (
      <Banner
        status="info"
        title={m.practice_empty_title()}
        description={m.practice_empty_body()}
        endContent={
          <Button
            label={m.practice_empty_action()}
            onClick={() => void navigate({ to: '/' })}
            data-testid="practice-empty-home"
          />
        }
        data-testid="practice-empty"
      />
    );
  } else if (view.needsKey) {
    body = (
      <Banner
        status="info"
        title={m.practice_need_key()}
        endContent={
          <Button
            label={m.home_need_key_action()}
            onClick={() => void navigate({ to: '/settings' })}
          />
        }
        data-testid="practice-need-key"
      />
    );
  } else {
    body = (
      <VStack gap={3}>
        <Button
          label={m.practice_start()}
          variant="primary"
          isLoading={starting}
          onClick={() => void start()}
          data-testid="practice-start"
        />
        {error === undefined ? null : (
          <Banner
            status="error"
            title={m.practice_failed({ reason: error })}
            data-testid="practice-error"
          />
        )}
      </VStack>
    );
  }

  return (
    <Layout
      header={<AppHeader />}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6} maxWidth="68ch">
            <VStack gap={2}>
              <Heading level={2}>{m.practice_title()}</Heading>
              <Text color="secondary">{m.practice_intro()}</Text>
            </VStack>
            {body}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
