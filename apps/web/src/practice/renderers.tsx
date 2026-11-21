// Renderers of the exercise types (plan luyen-tap-graph.md A6), keyed by type: adding a type adds
// an entry here, and the screen asks only for the types this registry renders. Each renderer
// shows the exercise, collects a draft answer (not stored until submitted) and, once graded, what
// the right answer was.
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import type { ExerciseView, PublicExerciseContent } from '@kd-learn/api';
import type { ExerciseAnswer, ExerciseContent, ExerciseTypeId } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';
import { useState, type ReactNode } from 'react';

type ContentOf<T extends ExerciseTypeId> = Extract<PublicExerciseContent, { type: T }>;
type SolutionOf<T extends ExerciseTypeId> = Extract<ExerciseContent, { type: T }>;
type AnswerOf<T extends ExerciseTypeId> = Extract<ExerciseAnswer, { type: T }>;

export interface RendererProps<T extends ExerciseTypeId> {
  readonly exerciseId: string;
  readonly content: ContentOf<T>;
  /** The stored answer, once submitted: the renderer shows it read-only. */
  readonly answer: AnswerOf<T> | undefined;
  /** Called with a complete answer; undefined while the draft is not one. */
  readonly onDraft: (answer: AnswerOf<T> | undefined) => void;
}

export interface ExerciseRenderer<T extends ExerciseTypeId> {
  readonly label: () => string;
  readonly Body: (props: RendererProps<T>) => ReactNode;
  /** What the right answer was, from the solution; undefined when the feedback says it all. */
  readonly Solution?: (props: { readonly solution: SolutionOf<T> }) => ReactNode;
}

function MultipleChoice({ exerciseId, content, answer, onDraft }: RendererProps<'multipleChoice'>) {
  const [choice, setChoice] = useState(answer === undefined ? '' : String(answer.choice));
  return (
    <VStack gap={3}>
      <Text>{content.question}</Text>
      <RadioList
        label={m.practice_choice_label()}
        value={choice}
        isDisabled={answer !== undefined}
        onChange={(value) => {
          setChoice(value);
          onDraft({ type: 'multipleChoice', choice: Number(value) });
        }}
        htmlName={`choice-${exerciseId}`}
        data-testid="exercise-options"
      >
        {content.options.map((option, index) => (
          <RadioListItem key={option} label={option} value={String(index)} />
        ))}
      </RadioList>
    </VStack>
  );
}

function TextExercise({
  question,
  stored,
  onText,
}: {
  readonly question: string;
  readonly stored: string | undefined;
  readonly onText: (text: string | undefined) => void;
}) {
  const [text, setText] = useState(stored ?? '');
  return (
    <VStack gap={3}>
      <Text>{question}</Text>
      <TextArea
        label={m.practice_answer_label()}
        value={text}
        isReadOnly={stored !== undefined}
        onChange={(value) => {
          setText(value);
          onText(value.trim() === '' ? undefined : value.trim());
        }}
        data-testid="exercise-text"
      />
    </VStack>
  );
}

function ShortAnswer({ content, answer, onDraft }: RendererProps<'shortAnswer'>) {
  return (
    <TextExercise
      question={content.question}
      stored={answer?.text}
      onText={(text) => onDraft(text === undefined ? undefined : { type: 'shortAnswer', text })}
    />
  );
}

function ExplainReasoning({ content, answer, onDraft }: RendererProps<'explainReasoning'>) {
  return (
    <TextExercise
      question={content.question}
      stored={answer?.text}
      onText={(text) =>
        onDraft(text === undefined ? undefined : { type: 'explainReasoning', text })
      }
    />
  );
}

function OrderChain({ content, answer, onDraft }: RendererProps<'orderChain'>) {
  const textOf = new Map(content.items.map((item) => [item.propositionId, item.text]));
  const [order, setOrder] = useState<ReadonlyArray<string>>(
    answer?.order ?? content.items.map((item) => item.propositionId),
  );
  const move = (index: number, by: -1 | 1) => {
    const next = [...order];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    setOrder(next);
    onDraft({ type: 'orderChain', order: next });
  };
  return (
    <VStack gap={3}>
      <Text>{m.practice_order_hint()}</Text>
      <List hasDividers listStyle="decimal" data-testid="exercise-order">
        {order.map((id, index) => (
          <ListItem
            key={id}
            itemKey={id}
            label={<Text>{textOf.get(id) ?? id}</Text>}
            endContent={
              answer === undefined ? (
                <HStack gap={1}>
                  <Button
                    label={m.practice_move_up()}
                    size="sm"
                    variant="ghost"
                    isDisabled={index === 0}
                    onClick={() => move(index, -1)}
                    data-testid="order-up"
                  />
                  <Button
                    label={m.practice_move_down()}
                    size="sm"
                    variant="ghost"
                    isDisabled={index === order.length - 1}
                    onClick={() => move(index, 1)}
                    data-testid="order-down"
                  />
                </HStack>
              ) : undefined
            }
          />
        ))}
      </List>
    </VStack>
  );
}

/** One order that respects every constraint (Kahn's algorithm, keeping the shown order on ties). */
const validOrder = (solution: SolutionOf<'orderChain'>): ReadonlyArray<string> => {
  const ids = solution.items.map((item) => item.propositionId);
  const out: Array<string> = [];
  const left = new Set(ids);
  while (left.size > 0) {
    const next =
      ids.find(
        (id) =>
          left.has(id) && !solution.constraints.some((c) => c.after === id && left.has(c.before)),
      ) ?? [...left][0]!;
    out.push(next);
    left.delete(next);
  }
  return out;
};

export const exerciseRenderers: { readonly [T in ExerciseTypeId]: ExerciseRenderer<T> } = {
  multipleChoice: {
    label: m.practice_type_multipleChoice,
    Body: MultipleChoice,
    Solution: ({ solution }) => (
      <Text data-testid="exercise-solution">
        {m.practice_right_option({ option: solution.options[solution.correctIndex] ?? '' })}
      </Text>
    ),
  },
  shortAnswer: { label: m.practice_type_shortAnswer, Body: ShortAnswer },
  explainReasoning: {
    label: m.practice_type_explainReasoning,
    Body: ExplainReasoning,
  },
  orderChain: {
    label: m.practice_type_orderChain,
    Body: OrderChain,
    Solution: ({ solution }) => {
      const textOf = new Map(solution.items.map((item) => [item.propositionId, item.text]));
      return (
        <List
          header={<Text weight="semibold">{m.practice_valid_order()}</Text>}
          listStyle="decimal"
          data-testid="exercise-solution"
        >
          {validOrder(solution).map((id) => (
            <ListItem key={id} label={<Text>{textOf.get(id) ?? id}</Text>} />
          ))}
        </List>
      );
    },
  },
};

/** The types the screen can render: what practice asks the server for. */
export const renderedTypes = Object.keys(exerciseRenderers) as ReadonlyArray<ExerciseTypeId>;

/** Renders one exercise with the renderer of its type. */
export function ExerciseBody({
  exercise,
  onDraft,
}: {
  readonly exercise: ExerciseView;
  readonly onDraft: (answer: ExerciseAnswer | undefined) => void;
}) {
  const renderer = exerciseRenderers[exercise.content.type] as ExerciseRenderer<ExerciseTypeId>;
  const Body = renderer.Body as (props: RendererProps<ExerciseTypeId>) => ReactNode;
  return (
    <Body
      exerciseId={exercise.exerciseId}
      content={exercise.content as never}
      answer={exercise.answer as never}
      onDraft={onDraft as never}
    />
  );
}

export function ExerciseSolution({ exercise }: { readonly exercise: ExerciseView }) {
  if (exercise.solution === undefined) return null;
  const renderer = exerciseRenderers[exercise.solution.type] as ExerciseRenderer<ExerciseTypeId>;
  const Solution = renderer.Solution as
    ((props: { readonly solution: ExerciseContent }) => ReactNode) | undefined;
  return Solution === undefined ? null : <Solution solution={exercise.solution} />;
}
