import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import { currentStep, type EventLog, type Session } from '@kd-learn/core';
import { LessonMarkdown } from '@kd-learn/ui/components/LessonMarkdown';
import { useEffect, useRef, useState } from 'react';
import type { RunnerState } from './runner';
import type { LessonActions } from './source';
import { failureText } from './view';

/** One side thread per step (plan A5), and one for the time before there is a step. */
export const sideThreadId = (session: Session): string => {
  const step = currentStep(session);
  return step === undefined ? 'general' : `step:${step.id}`;
};

/** The failure recorded for the last answer of the thread, if the log ends there. */
function lastSideFailure(log: EventLog, threadId: string) {
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]!;
    if (event._tag === 'SideTurnFailed' && event.threadId === threadId) return event;
    if (event._tag === 'SideMessageAppended' && event.threadId === threadId) return undefined;
  }
  return undefined;
}

export interface SideChatProps {
  readonly session: Session;
  readonly log: EventLog;
  readonly runner: LessonActions;
  readonly state: RunnerState['side'];
}

/** Quick questions tied to the current step. Never part of the main lesson (plan A5). */
export function SideChat({ session, log, runner, state }: SideChatProps) {
  const threadId = sideThreadId(session);
  const step = currentStep(session);
  const thread = session.sideThreads[threadId] ?? [];
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLElement>(null);

  const running = state.running && state.threadId === threadId;
  const live = running ? state.live : undefined;
  const waitingForAnswer = thread.at(-1)?.role === 'user' && !running;
  const logged = lastSideFailure(log, threadId);
  const failure = state.threadId === threadId ? state.failure : undefined;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.length, live]);

  const send = () => {
    const content = draft.trim();
    if (content === '' || running) return;
    setDraft('');
    void Promise.resolve(runner.sendSide(threadId, content)).then((kept) => {
      if (kept === false) setDraft((current) => (current === '' ? content : current));
    });
  };

  return (
    <VStack gap={3} data-testid="side-chat">
      <VStack gap={1}>
        <Heading level={2}>{m.side_title()}</Heading>
        <Text type="supporting">{m.side_hint()}</Text>
        <Text type="supporting" color="accent" data-testid="side-step">
          {step === undefined ? m.side_general() : m.side_step({ title: step.title })}
        </Text>
      </VStack>

      <VStack gap={3} data-testid="side-messages">
        {thread.length === 0 && live === undefined ? (
          <Text type="supporting">{m.side_empty()}</Text>
        ) : null}
        {thread.map((message) =>
          message.role === 'user' ? (
            <Card key={message.messageId} padding={3} variant="muted">
              <Text>{message.content}</Text>
            </Card>
          ) : (
            <LessonMarkdown key={message.messageId}>{message.content}</LessonMarkdown>
          ),
        )}
        {live !== undefined && live !== '' ? (
          <LessonMarkdown isStreaming>{live}</LessonMarkdown>
        ) : null}
        <VStack ref={endRef} />
      </VStack>

      {!waitingForAnswer && !running && failure !== undefined ? (
        <Banner
          status="error"
          title={m.side_error({ message: failureText(failure) })}
          data-testid="side-failed"
        />
      ) : null}
      {waitingForAnswer ? (
        <Banner
          status="error"
          title={m.side_error({
            message:
              failure !== undefined
                ? failureText(failure)
                : (logged?.message ?? m.turn_interrupted_title()),
          })}
          endContent={
            <Button
              label={m.side_retry()}
              size="sm"
              onClick={() => void runner.retrySide(threadId)}
              data-testid="side-retry"
            />
          }
        />
      ) : null}

      <TextArea
        label={m.side_label()}
        placeholder={m.side_placeholder()}
        value={draft}
        onChange={setDraft}
        rows={2}
        isDisabled={running}
        data-testid="side-input"
      />
      <Button
        label={m.side_send()}
        variant="secondary"
        onClick={send}
        isDisabled={running || draft.trim() === ''}
        data-testid="side-send"
      />
    </VStack>
  );
}
