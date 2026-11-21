// Builds what the model sees: the system prompt (profile prompt + session context) and the messages.
// Pure string work over a `Session`.
import { currentStep } from '@kd-learn/core';
import type { HistoryMessage, Session } from '@kd-learn/core';
import type { Message } from '@kd-learn/ai/port';

/** Sent as the user message when a turn has no learner input (the agent speaks first). */
export const NO_INPUT = '(The learner has not written anything yet. Go ahead.)';

/** How many recent main-thread messages the side chat sees (plan A5), and the cap on each. */
const SIDE_CONTEXT_MESSAGES = 6;
const SIDE_CONTEXT_CHARS = 1200;

const languageLine = (session: Session) =>
  `Language: write every message to the learner in "${session.profile.language}" (a BCP 47 tag). Tool arguments (ids, levels) keep the format the tool asks for; free-text tool fields may use the same language.`;

const stepStatus = (session: Session, id: string): string => {
  if (session.completedSteps.includes(id)) return 'done';
  if (session.skippedSteps.includes(id)) return 'skipped';
  if (session.state._tag === 'Teaching' && session.state.stepId === id) return 'current';
  return 'pending';
};

const planOutline = (session: Session): string =>
  session.plan === undefined
    ? 'No plan yet.'
    : session.plan.nodes
        .map(
          (node) =>
            `- ${node.id} [${stepStatus(session, node.id)}] ${node.title}: ${node.goal}` +
            (node.dependsOn.length > 0 ? ` (after: ${node.dependsOn.join(', ')})` : ''),
        )
        .join('\n');

const assessmentBlock = (session: Session): string => {
  const a = session.assessment;
  if (a === undefined) return 'Assessment: none.';
  const list = (items: ReadonlyArray<string>) => (items.length > 0 ? items.join('; ') : 'none');
  return [
    `Assessment (from the diagnostic phase): level ${a.level}.`,
    `Summary: ${a.summary}`,
    `Strengths: ${list(a.strengths)}`,
    `Gaps: ${list(a.gaps)}`,
  ].join('\n');
};

/** True when the Prober has used its question budget and must submit the assessment now. */
export const mustSubmitAssessment = (session: Session): boolean =>
  session.state._tag === 'Probing' &&
  session.state.turnsCompleted >= session.profile.maxProbeQuestions;

/** Session context for the main-thread agent of the current state. */
export const mainContext = (session: Session): string => {
  const lines = [`## Session context`, `Topic: ${session.topic}`, languageLine(session)];
  const { state } = session;
  switch (state._tag) {
    case 'Probing': {
      const max = session.profile.maxProbeQuestions;
      lines.push(
        `Phase: diagnostic questions. Questions asked so far: ${state.turnsCompleted} of at most ${max}.`,
        mustSubmitAssessment(session)
          ? 'You have used the whole question budget: do not ask another question. Call submit_assessment now.'
          : 'Ask your next question, or call submit_assessment now if you already have enough evidence.',
      );
      break;
    }
    case 'Planning':
      lines.push(
        'Phase: planning. There is no plan yet. Call create_plan in this turn.',
        assessmentBlock(session),
      );
      break;
    case 'Teaching': {
      const step = currentStep(session);
      lines.push('Phase: teaching.', assessmentBlock(session), 'Plan:', planOutline(session));
      if (step === undefined) {
        lines.push('Every step is resolved. Wrap up the lesson as described.');
      } else {
        lines.push(
          `Current step: ${step.id} - ${step.title}. Goal: ${step.goal}`,
          `Turns already spent on this step: ${state.turnsInStep} (the learner may skip it after ${session.profile.maxTurnsPerStep}).`,
        );
      }
      break;
    }
    case 'Done':
      lines.push('Phase: finished.', 'Plan:', planOutline(session));
      break;
  }
  return lines.join('\n');
};

export const mainSystem = (session: Session): string => {
  const prompt =
    session.state._tag === 'Probing'
      ? session.profile.prompts.prober
      : session.profile.prompts.teacher;
  return `${prompt}\n\n${mainContext(session)}`;
};

const clip = (text: string) =>
  text.length <= SIDE_CONTEXT_CHARS ? text : `${text.slice(0, SIDE_CONTEXT_CHARS)}...`;

/** Side chat context: plan, current step and the last few messages of the main thread (plan A5). */
export const sideSystem = (session: Session): string => {
  const step = currentStep(session);
  const recent = session.history
    .slice(-SIDE_CONTEXT_MESSAGES)
    .map((m) => `${m.role === 'user' ? 'Learner' : 'Teacher'}: ${clip(m.content)}`)
    .join('\n\n');
  const lines = [
    '## Lesson context',
    `Topic: ${session.topic}`,
    languageLine(session),
    'Plan:',
    planOutline(session),
    step === undefined
      ? 'Current step: none.'
      : `Current step: ${step.id} - ${step.title}. Goal: ${step.goal}`,
    'Recent messages of the main lesson (oldest first):',
    recent === '' ? '(none yet)' : recent,
  ];
  return `${session.profile.prompts.sideChat}\n\n${lines.join('\n')}`;
};

/**
 * Messages for the model. Empty text becomes `NO_INPUT`, and consecutive messages of the same role
 * are joined, because providers want strict user/assistant alternation.
 */
export const toMessages = (messages: ReadonlyArray<HistoryMessage>): ReadonlyArray<Message> => {
  const out: Array<Message> = [];
  for (const message of messages) {
    const content =
      message.role === 'user' && message.content.trim() === '' ? NO_INPUT : message.content;
    const last = out.at(-1);
    if (last !== undefined && last.role === message.role) {
      out[out.length - 1] = { role: last.role, content: `${last.content}\n\n${content}` };
    } else {
      out.push({ role: message.role, content });
    }
  }
  return out;
};
