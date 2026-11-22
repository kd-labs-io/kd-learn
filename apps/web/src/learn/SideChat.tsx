import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';
import { Heading } from '@astryxdesign/core/Heading';
import { Selector } from '@astryxdesign/core/Selector';
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

/** Name of a thread for the picker: the step title, or "the lesson in general". */
const threadName = (session: Session, threadId: string): string => {
  if (!threadId.startsWith('step:')) return m.side_general();
  const id = threadId.slice('step:'.length);
  return session.plan?.nodes.find((node) => node.id === id)?.title ?? id;
};

/**
 * Quick questions tied to the current step. Never part of the main lesson (plan A5). Earlier
 * threads (other steps, or every step once the lesson is done) can be read back from the picker;
 * only the current one takes new questions.
 */
export function SideChat({ session, log, runner, state }: SideChatProps) {
  const currentThread = sideThreadId(session);
  const others = Object.keys(session.sideThreads).filter(
    (id) => id !== currentThread && (session.sideThreads[id]?.length ?? 0) > 0,
  );
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const threadId =
    picked !== undefined && (picked === currentThread || others.includes(picked))
      ? picked
      : currentThread;
  const isCurrent = threadId === currentThread;
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
    if (content === '' || running || !isCurrent) return;
    setDraft('');
    void Promise.resolve(runner.sendSide(threadId, content)).then((kept) => {
      if (kept === false) setDraft((current) => (current === '' ? content : current));
    });
  };

  return (
    <VStack gap={3} data-testid="side-chat">
      <VStack gap={2}>
        <Heading level={2}>{m.side_title()}</Heading>
        <Text type="supporting">{m.side_hint()}</Text>
        {others.length === 0 ? (
          <Text type="supporting" color="accent" data-testid="side-step">
            {m.side_thread_label()}: {threadName(session, threadId)}
          </Text>
        ) : (
          <Selector
            label={m.side_thread_label()}
            size="sm"
            value={threadId}
            onChange={setPicked}
            options={[
              { value: currentThread, label: threadName(session, currentThread) },
              {
                type: 'section',
                title: m.side_history(),
                options: others.map((id) => ({ value: id, label: threadName(session, id) })),
              },
            ]}
            data-testid="side-thread"
          />
        )}
      </VStack>

      <VStack gap={3} data-testid="side-messages">
        {thread.length === 0 && live === undefined ? (
          <Text type="supporting">{m.side_empty()}</Text>
        ) : null}
        {thread.map((message) =>
          message.role === 'user' ? (
            <ChatMessage key={message.messageId} sender="user">
              <ChatMessageBubble>{message.content}</ChatMessageBubble>
            </ChatMessage>
          ) : (
            <Card key={message.messageId} padding={3} elevation="low">
              <LessonMarkdown>{message.content}</LessonMarkdown>
            </Card>
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
      {waitingForAnswer && isCurrent ? (
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

      {isCurrent ? (
        <>
          <TextArea
            label={m.side_label()}
            placeholder={m.side_placeholder()}
            value={draft}
            onChange={setDraft}
            rows={2}
            isDisabled={running}
            enterKeyHint="send"
            data-testid="side-input"
          />
          <Button
            label={m.side_send()}
            variant="primary"
            onClick={send}
            isDisabled={running || draft.trim() === ''}
            data-testid="side-send"
          />
        </>
      ) : null}
    </VStack>
  );
}
