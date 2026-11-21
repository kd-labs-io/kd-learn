import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Collapsible } from '@astryxdesign/core/Collapsible';
import { Drawer } from '@astryxdesign/core/Drawer';
import { Heading } from '@astryxdesign/core/Heading';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { HStack } from '@astryxdesign/core/HStack';
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
} from '@astryxdesign/core/Layout';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import { m } from '@kd-learn/i18n';
import { canSkipStep, findInterruptedTurn, type EventLog, type Session } from '@kd-learn/core';
import { LessonMarkdown } from '@kd-learn/ui/components/LessonMarkdown';
import { useNavigate } from '@tanstack/react-router';
import { Result } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../storage';
import { useRunner, useStoragePersistent, useTurnRunningElsewhere } from './hooks';
import { PlanPanel } from './PlanPanel';
import { shouldAutoStart, type RunnerState, type SessionRunner } from './runner';
import { SideChat } from './SideChat';
import {
  conversationOf,
  failureAction,
  failureText,
  hasUnresolvedTurn,
  turnBanner,
  type TurnBanner,
} from './view';

/** The learning screen of one session (plan step 7). */
export function LearnScreen({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const view = useSession(sessionId);
  const { runner, state } = useRunner(sessionId);
  const persistent = useStoragePersistent();
  const showPlanColumn = useMediaQuery('(min-width: 768px)');
  const showSideColumn = useMediaQuery('(min-width: 1180px)');
  const [sideOpen, setSideOpen] = useState(false);

  const projected = view.status === 'ready' ? view.data.session : undefined;
  const session =
    projected !== undefined && Result.isSuccess(projected) ? projected.success : undefined;
  const log: EventLog = view.status === 'ready' ? view.data.log : [];

  // A stale failure from an earlier visit (no key, a lost connection) must not outlive the visit.
  useEffect(() => runner.clearFailure(), [runner]);

  // The first Prober turn and the planning turn start without learner input (plan A4).
  const due = session !== undefined && shouldAutoStart(session);
  useEffect(() => {
    if (due) void runner.autoStart();
  }, [due, runner]);

  const hasOpenTurn = session !== undefined && findInterruptedTurn(session) !== undefined;
  const elsewhere = useTurnRunningElsewhere(sessionId, hasOpenTurn && !state.main.running);

  const home = () => void navigate({ to: '/' });
  const settings = () => void navigate({ to: '/settings' });

  if (view.status === 'loading') {
    return (
      <Layout
        content={
          <LayoutContent padding={6}>
            <Spinner label={m.learn_loading()} />
          </LayoutContent>
        }
      />
    );
  }
  if (view.status === 'error') {
    return (
      <Layout
        content={
          <LayoutContent padding={6}>
            <Banner status="error" title={m.storage_error({ reason: view.error.message })} />
          </LayoutContent>
        }
      />
    );
  }
  if (log.length === 0) {
    return (
      <Layout
        content={
          <LayoutContent padding={6}>
            <VStack gap={4} maxWidth="68ch">
              <Banner status="warning" title={m.learn_not_found()} />
              <Button label={m.nav_back()} onClick={home} />
            </VStack>
          </LayoutContent>
        }
      />
    );
  }
  if (session === undefined) {
    const reason =
      projected !== undefined && Result.isFailure(projected) ? projected.failure.message : '';
    return (
      <Layout
        content={
          <LayoutContent padding={6}>
            <VStack gap={4} maxWidth="68ch">
              <Banner status="error" title={m.learn_broken({ reason })} />
              <Button label={m.nav_back()} onClick={home} />
            </VStack>
          </LayoutContent>
        }
      />
    );
  }

  const planPanel = <PlanPanel session={session} />;
  const sideChat = <SideChat session={session} log={log} runner={runner} state={state.side} />;

  return (
    <>
      <Layout
        header={
          <LayoutHeader hasDivider padding={3}>
            <HStack gap={3} vAlign="center" justify="between">
              <HStack gap={2} vAlign="center">
                <Button
                  label={m.nav_home()}
                  variant="ghost"
                  size="sm"
                  onClick={home}
                  data-testid="nav-home"
                />
                <Heading level={3} accessibilityLevel={1} maxLines={1} data-testid="session-topic">
                  {session.topic}
                </Heading>
              </HStack>
              <HStack gap={2} vAlign="center">
                {showSideColumn ? null : (
                  <Button
                    label={m.side_open()}
                    variant="secondary"
                    size="sm"
                    onClick={() => setSideOpen(true)}
                    data-testid="side-open"
                  />
                )}
                <Button label={m.nav_settings()} variant="ghost" size="sm" onClick={settings} />
              </HStack>
            </HStack>
          </LayoutHeader>
        }
        start={
          showPlanColumn ? (
            <LayoutPanel width={300} hasDivider label={m.plan_title()}>
              {planPanel}
            </LayoutPanel>
          ) : undefined
        }
        end={
          showSideColumn ? (
            <LayoutPanel width={360} hasDivider label={m.side_title()}>
              {sideChat}
            </LayoutPanel>
          ) : undefined
        }
        content={
          <LayoutContent padding={4} label={m.conv_tutor()}>
            <VStack gap={5} maxWidth="68ch" data-testid="conversation">
              {showPlanColumn ? null : (
                <Collapsible
                  trigger={<Text type="label">{m.plan_title()}</Text>}
                  defaultIsOpen={false}
                >
                  {planPanel}
                </Collapsible>
              )}
              <Conversation session={session} state={state} />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider padding={3}>
            <VStack gap={3} maxWidth="68ch">
              {persistent === false ? (
                <Banner
                  status="warning"
                  title={m.storage_not_persistent_title()}
                  description={m.storage_not_persistent_body()}
                  data-testid="not-persistent"
                />
              ) : null}
              <Status
                session={session}
                state={state}
                elsewhere={elsewhere}
                runner={runner}
                onSettings={settings}
                onNew={home}
              />
              {session.state._tag === 'Done' ? null : (
                <Composer session={session} state={state} elsewhere={elsewhere} runner={runner} />
              )}
            </VStack>
          </LayoutFooter>
        }
      />
      {showSideColumn ? null : (
        <Drawer isOpen={sideOpen} onOpenChange={setSideOpen} label={m.side_title()} padding={4}>
          {sideChat}
        </Drawer>
      )}
    </>
  );
}

function Conversation({ session, state }: { session: Session; state: RunnerState }) {
  const items = conversationOf(session);
  const endRef = useRef<HTMLElement>(null);
  const { live } = state.main;
  // The live text is shown until its turn is in the log; after that the stored message replaces it.
  const liveTurn =
    live === undefined ? undefined : session.turns.find((turn) => turn.turnId === live.turnId);
  const showLive = live !== undefined && (liveTurn === undefined || liveTurn.status === 'started');
  const writing = state.main.running && showLive;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length, live?.text.length]);

  return (
    <VStack gap={5}>
      {items.map((item) =>
        item.role === 'user' ? (
          <Card key={item.key} padding={3} variant="muted" data-testid="msg-user">
            <VStack gap={1}>
              <Text type="supporting">{m.conv_you()}</Text>
              <Text>{item.content}</Text>
            </VStack>
          </Card>
        ) : (
          <VStack key={item.key} gap={1} data-testid="msg-tutor">
            <Text type="supporting">{m.conv_tutor()}</Text>
            <LessonMarkdown>{item.content}</LessonMarkdown>
          </VStack>
        ),
      )}
      {showLive ? (
        <VStack gap={1} data-testid="msg-live">
          <Text type="supporting">{m.conv_tutor()}</Text>
          {live.text === '' ? (
            <Spinner size="sm" label={m.conv_writing()} />
          ) : (
            <LessonMarkdown isStreaming={writing}>{live.text}</LessonMarkdown>
          )}
        </VStack>
      ) : null}
      <VStack ref={endRef} />
    </VStack>
  );
}

interface StatusProps {
  readonly session: Session;
  readonly state: RunnerState;
  readonly elsewhere: boolean;
  readonly runner: SessionRunner;
  readonly onSettings: () => void;
  readonly onNew: () => void;
}

/** Banners about the turn: interrupted, failed, running elsewhere, skip a step, lesson done. */
function Status({ session, state, elsewhere, runner, onSettings, onNew }: StatusProps) {
  if (session.state._tag === 'Done') {
    return (
      <Banner
        status="success"
        title={m.done_title()}
        description={m.done_body()}
        endContent={<Button label={m.done_new()} onClick={onNew} />}
        data-testid="lesson-done"
      />
    );
  }
  if (state.main.running) return null;
  if (elsewhere) {
    return <Banner status="info" title={m.turn_elsewhere()} data-testid="turn-elsewhere" />;
  }

  const banner: TurnBanner = turnBanner(session, state.main.failure);
  if (banner.kind === 'interrupted') {
    return (
      <Banner
        status="warning"
        title={m.turn_interrupted_title()}
        description={m.turn_interrupted_body()}
        endContent={
          <Button
            label={m.turn_retry()}
            onClick={() => void runner.retry()}
            data-testid="turn-retry"
          />
        }
        data-testid="turn-interrupted"
      />
    );
  }
  if (banner.kind === 'failed') {
    const { failure } = banner;
    const action = failureAction(failure);
    const canRetry = failure.retryable && hasUnresolvedTurn(session);
    return (
      <Banner
        status="error"
        title={m.turn_failed_title()}
        description={failureText(failure)}
        endContent={
          <HStack gap={2}>
            {canRetry ? (
              <Button
                label={m.turn_retry()}
                onClick={() => void runner.retry()}
                data-testid="turn-retry"
              />
            ) : null}
            {action === 'settings' ? (
              <Button label={m.error_open_settings()} onClick={onSettings} />
            ) : null}
            {action === 'new-session' ? (
              <Button label={m.error_new_session()} onClick={onNew} />
            ) : null}
          </HStack>
        }
        data-testid="turn-failed"
        data-code={failure.code}
      />
    );
  }

  if (
    canSkipStep(session) &&
    session.state._tag === 'Teaching' &&
    session.state.stepId !== undefined
  ) {
    const { stepId } = session.state;
    return (
      <Banner
        status="info"
        title={m.skip_hint()}
        endContent={
          <Button
            label={m.skip_step()}
            onClick={() => void runner.skipStep(stepId)}
            data-testid="skip-step"
          />
        }
      />
    );
  }
  return null;
}

interface ComposerProps {
  readonly session: Session;
  readonly state: RunnerState;
  readonly elsewhere: boolean;
  readonly runner: SessionRunner;
}

function Composer({ session, state, elsewhere, runner }: ComposerProps) {
  const [draft, setDraft] = useState('');
  // The tutor speaks first while probing and after the assessment; answers only make sense once
  // the previous turn is settled (a failed or interrupted turn is retried, not skipped).
  const blocked =
    state.main.running ||
    elsewhere ||
    hasUnresolvedTurn(session) ||
    session.state._tag === 'Planning' ||
    session.turns.length === 0;

  const send = () => {
    const input = draft.trim();
    if (input === '' || blocked) return;
    setDraft('');
    void runner.send(input);
  };

  return (
    <VStack gap={2}>
      <TextArea
        label={m.composer_label()}
        placeholder={m.composer_placeholder()}
        value={draft}
        onChange={setDraft}
        rows={3}
        isDisabled={blocked}
        data-testid="composer-input"
      />
      <HStack justify="end">
        <Button
          label={m.composer_send()}
          variant="primary"
          onClick={send}
          isDisabled={blocked || draft.trim() === ''}
          data-testid="composer-send"
        />
      </HStack>
    </VStack>
  );
}
