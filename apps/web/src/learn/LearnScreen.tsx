import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';
import { Drawer } from '@astryxdesign/core/Drawer';
import { Heading } from '@astryxdesign/core/Heading';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { SideNavSection } from '@astryxdesign/core/SideNav';
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
import { canSkipStep, type Citation, type EventLog, type Session } from '@kd-learn/core';
import { LessonFigure, type FigureBodyLoader } from '@kd-learn/ui/components/LessonFigure';
import { preloadMath } from '@kd-learn/ui/components/LessonMarkdown';
import { Result } from 'effect';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RailSlot } from '../app/AppRail';
import { useThemeControl } from '../theme/ThemeRoot';
import { figureVarsOf } from './figures';
import { ChunksDrawer } from '../sources/ChunksDrawer';
import { LessonSourcesPanel } from '../sources/LessonSourcesPanel';
import { PlanPanel } from './PlanPanel';
import { shouldAutoStart, type RunnerState } from './runner';
import { SideChat } from './SideChat';
import type { LessonActions, LessonSource } from './source';
import {
  conversationOf,
  failureAction,
  failureText,
  hasUnresolvedTurn,
  planRows,
  turnBanner,
  type TurnBanner,
} from './view';

const toolKey = 'kd-learn.lesson-tool';

type Tool = 'side' | 'sources';

/** Which tool the right column shows, remembered on this device (a convenience: may fail silently). */
function useLessonTool(): [Tool, (tool: Tool) => void] {
  const [tool, setTool] = useState<Tool>('side');
  useEffect(() => {
    try {
      if (localStorage.getItem(toolKey) === 'sources') setTool('sources');
    } catch {
      // Storage blocked: start on the side chat.
    }
  }, []);
  const set = (next: Tool) => {
    setTool(next);
    try {
      localStorage.setItem(toolKey, next);
    } catch {
      // Not remembered, still applied.
    }
  };
  return [tool, set];
}

/** Where the lesson stands, under its title: probing, planning, step x of y, finished. */
export function lessonProgress(session: Session): string {
  if (session.state._tag === 'Done') return m.lesson_progress_done();
  const rows = planRows(session);
  if (rows.length === 0) {
    return session.state._tag === 'Planning' ? m.plan_phase_planning() : m.plan_phase_probing();
  }
  const resolved = session.completedSteps.length + session.skippedSteps.length;
  return m.lesson_progress({ current: Math.min(resolved + 1, rows.length), total: rows.length });
}

export interface LearnScreenProps {
  readonly source: LessonSource;
  readonly onHome: () => void;
  readonly onSettings: () => void;
}

/**
 * The learning screen of one session (plan step 7). The same screen serves guests (local DB) and
 * accounts (server log): it only sees a `LessonSource` (plan step 8).
 */
export function LearnScreen({ source, onHome: home, onSettings: settings }: LearnScreenProps) {
  const { view, state, actions: runner, elsewhere, persistent } = source;
  // Three columns on a wide screen: the rail (places and the plan), the lesson, and the lesson's
  // tools (quick questions, sources). Narrower, the tools open as drawers from the lesson's title
  // row; on a phone the rail itself is a drawer behind the menu button.
  const wideTools = useMediaQuery('(min-width: 1180px)');
  const [tool, setTool] = useLessonTool();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [cited, setCited] = useState<Citation | undefined>(undefined);

  const projected = view.status === 'ready' ? view.session : undefined;
  const session =
    projected !== undefined && Result.isSuccess(projected) ? projected.success : undefined;
  const log: EventLog = view.status === 'ready' ? view.log : [];

  // Formulas render at once on a reload instead of showing raw TeX while KaTeX loads.
  useEffect(preloadMath, []);

  // A stale failure from an earlier visit (no key, a lost connection) must not outlive the visit.
  useEffect(() => runner.clearFailure(), [runner]);

  // The first Prober turn and the planning turn start without learner input (plan A4).
  const due = session !== undefined && shouldAutoStart(session);
  // Also once the turn shown as running ends: an auto start skipped meanwhile is due again. A
  // failure stops it, so a turn that cannot start (no key) is not retried in a loop.
  const idle = !state.main.running && state.main.failure === undefined;
  useEffect(() => {
    if (due && idle) void runner.autoStart();
  }, [due, idle, runner]);

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
            <Banner status="error" title={m.storage_error({ reason: view.message })} />
          </LayoutContent>
        }
      />
    );
  }
  if (view.status === 'not-found' || log.length === 0) {
    return (
      <Layout
        content={
          <LayoutContent padding={6}>
            <VStack gap={4} maxWidth="68ch">
              <Banner
                status="warning"
                title={
                  view.status === 'not-found' ? m.learn_not_found_account() : m.learn_not_found()
                }
              />
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

  const sideChat = <SideChat session={session} log={log} runner={runner} state={state.side} />;
  const sourcesPanel =
    source.sources === undefined ? null : (
      <LessonSourcesPanel session={session} sources={source.sources} />
    );
  const sourcesLabel = m.lesson_sources({ count: session.sources.length });
  const shownTool: Tool = sourcesPanel === null ? 'side' : tool;

  return (
    <>
      <RailSlot>
        <SideNavSection title={m.plan_title()} isHeaderHidden>
          <PlanPanel session={session} />
        </SideNavSection>
      </RailSlot>
      <Layout
        end={
          wideTools ? (
            <LayoutPanel width={360} hasDivider label={m.lesson_tools()} padding={4}>
              <VStack gap={4}>
                {sourcesPanel === null ? null : (
                  <SegmentedControl
                    label={m.lesson_tools()}
                    value={shownTool}
                    onChange={(value) => setTool(value === 'sources' ? 'sources' : 'side')}
                    layout="fill"
                    size="sm"
                  >
                    <SegmentedControlItem
                      value="side"
                      label={m.side_title()}
                      data-testid="side-open"
                    />
                    <SegmentedControlItem
                      value="sources"
                      label={sourcesLabel}
                      data-testid="lesson-sources-open"
                    />
                  </SegmentedControl>
                )}
                {shownTool === 'side' ? sideChat : sourcesPanel}
              </VStack>
            </LayoutPanel>
          ) : undefined
        }
        content={
          // One centred reading column for the title, the conversation and the answer box, so the
          // box sits under what it answers (plan cai-thien-ux.md A2 #6, #7).
          <Layout
            contentWidth="72ch"
            header={
              <LayoutHeader padding={4}>
                {/* Wraps on a phone: the tools go under the topic instead of being cut off. */}
                <HStack gap={3} vAlign="center" justify="between" wrap="wrap">
                  <VStack gap={0.5}>
                    <Heading
                      level={2}
                      accessibilityLevel={1}
                      maxLines={2}
                      data-testid="session-topic"
                    >
                      {session.topic}
                    </Heading>
                    <Text type="supporting" data-testid="lesson-progress">
                      {lessonProgress(session)}
                    </Text>
                  </VStack>
                  {wideTools ? null : (
                    <HStack gap={2} vAlign="center" wrap="wrap">
                      {sourcesPanel === null ? null : (
                        <Button
                          label={sourcesLabel}
                          variant="ghost"
                          size="sm"
                          onClick={() => setSourcesOpen(true)}
                          data-testid="lesson-sources-open"
                        />
                      )}
                      <Button
                        label={m.side_open()}
                        variant="secondary"
                        size="sm"
                        onClick={() => setDrawerOpen(true)}
                        aria-expanded={drawerOpen}
                        data-testid="side-open"
                      />
                    </HStack>
                  )}
                </HStack>
              </LayoutHeader>
            }
            content={
              <LayoutContent padding={4} label={m.conv_tutor()}>
                <VStack gap={5} data-testid="conversation">
                  <Conversation
                    session={session}
                    state={state}
                    onCite={setCited}
                    loadFigure={source.loadFigure}
                  />
                </VStack>
              </LayoutContent>
            }
            footer={
              <LayoutFooter padding={3}>
                <VStack gap={3}>
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
                    <Composer
                      session={session}
                      state={state}
                      elsewhere={elsewhere}
                      runner={runner}
                    />
                  )}
                </VStack>
              </LayoutFooter>
            }
          />
        }
      />
      {source.sources === undefined ? null : (
        <>
          {wideTools ? null : (
            <Drawer
              isOpen={sourcesOpen}
              onOpenChange={setSourcesOpen}
              label={m.lesson_sources_title()}
              padding={4}
            >
              {sourcesPanel}
            </Drawer>
          )}
          <ChunksDrawer
            title={
              cited === undefined
                ? undefined
                : (session.sources.find((s) => s.sourceId === cited.sourceId)?.title ??
                  m.sources_detached())
            }
            focus={cited?.ordinal}
            load={() => source.sources!.library.chunks(cited?.sourceId ?? '')}
            onClose={() => setCited(undefined)}
          />
        </>
      )}
      {wideTools ? null : (
        <Drawer isOpen={drawerOpen} onOpenChange={setDrawerOpen} label={m.side_title()} padding={4}>
          {sideChat}
        </Drawer>
      )}
    </>
  );
}

function Conversation({
  session,
  state,
  onCite,
  loadFigure,
}: {
  session: Session;
  state: RunnerState;
  onCite: (citation: Citation) => void;
  loadFigure: FigureBodyLoader;
}) {
  const titles = new Map(session.sources.map((s) => [s.sourceId, s.title]));
  const { theme, resolvedMode } = useThemeControl();
  const vars = figureVarsOf(theme, resolvedMode);
  const figures = useMemo(
    () => new Map(session.figures.map((figure) => [figure.figureId, figure])),
    [session.figures],
  );
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
          <ChatMessage key={item.key} sender="user" data-testid="msg-user">
            <ChatMessageBubble name={m.conv_you()}>{item.content}</ChatMessageBubble>
          </ChatMessage>
        ) : (
          <Card key={item.key} padding={4} elevation="low">
            <VStack gap={1} data-testid="msg-tutor">
              <Text type="label" color="accent">
                {m.conv_tutor()}
              </Text>
              <LessonFigure figures={figures} loadBody={loadFigure} vars={vars}>
                {item.content}
              </LessonFigure>
              {item.citations === undefined ? null : (
                <HStack gap={1} wrap="wrap" data-testid="citations">
                  {item.citations.map((citation) => (
                    <Button
                      key={citation.label}
                      size="sm"
                      variant="secondary"
                      label={`S${citation.label} · ${titles.get(citation.sourceId) ?? m.sources_detached()}`}
                      onClick={() => onCite(citation)}
                      data-testid="citation"
                    />
                  ))}
                </HStack>
              )}
            </VStack>
          </Card>
        ),
      )}
      {showLive ? (
        <Card padding={4} elevation="low">
          <VStack gap={1} data-testid="msg-live">
            <Text type="label" color="accent">
              {m.conv_tutor()}
            </Text>
            {live.text === '' ? (
              <Spinner size="sm" label={m.conv_writing()} />
            ) : (
              <LessonFigure
                figures={figures}
                loadBody={loadFigure}
                vars={vars}
                isStreaming={writing}
              >
                {live.text}
              </LessonFigure>
            )}
          </VStack>
        </Card>
      ) : null}
      <VStack ref={endRef} />
    </VStack>
  );
}

interface StatusProps {
  readonly session: Session;
  readonly state: RunnerState;
  readonly elsewhere: boolean;
  readonly runner: LessonActions;
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
  if (state.main.running) {
    const cancel = runner.cancel;
    return cancel === undefined ? null : (
      <HStack justify="end">
        <Button
          label={m.turn_stop()}
          variant="ghost"
          size="sm"
          onClick={() => void cancel()}
          data-testid="turn-stop"
        />
      </HStack>
    );
  }
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
  readonly runner: LessonActions;
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
    void Promise.resolve(runner.send(input)).then((kept) => {
      // Refused before anything was saved (account mode): give the text back.
      if (kept === false) setDraft((current) => (current === '' ? input : current));
    });
  };

  // Enter sends and Shift+Enter breaks the line, on a keyboard; a touch keyboard's Return keeps
  // its new line and the Send button sends.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const finePointer = useMediaQuery('(pointer: fine)');
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const input = inputRef.current;
    if (input === null || matchMedia('(pointer: coarse)').matches) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendRef.current();
      }
    };
    input.addEventListener('keydown', onKey);
    return () => input.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Card padding={3} elevation="low">
      <VStack gap={2}>
        <TextArea
          ref={inputRef}
          label={m.composer_label()}
          isLabelHidden
          placeholder={m.composer_placeholder()}
          value={draft}
          onChange={setDraft}
          rows={3}
          isDisabled={blocked}
          disabledMessage={m.composer_waiting()}
          enterKeyHint="send"
          data-testid="composer-input"
        />
        <HStack gap={3} vAlign="center" justify="between">
          {finePointer ? <Text type="supporting">{m.composer_hint()}</Text> : <VStack />}
          <Button
            label={m.composer_send()}
            variant="primary"
            onClick={send}
            isDisabled={blocked || draft.trim() === ''}
            data-testid="composer-send"
          />
        </HStack>
      </VStack>
    </Card>
  );
}
