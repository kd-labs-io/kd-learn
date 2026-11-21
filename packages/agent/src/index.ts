// Agents (plan 3.1): Prober, Teacher and side chat in phase 1. Depends on core and ports only.
import type { Session } from '@kd-learn/core';

export { defaultProfile } from './profile.ts';
export { runTurn, InvalidTurn, failureOf, modelName } from './turn.ts';
export type { AgentOutput, FailureInfo, TurnParams } from './turn.ts';
export { runSideChat } from './side-chat.ts';
export type { SideChatParams } from './side-chat.ts';
export { mainSystem, sideSystem, NO_INPUT } from './context.ts';

/**
 * True when the session needs an agent turn without learner input: the assessment is in and no
 * plan exists yet. The client starts a turn with empty input (plan A3) right after the turn that
 * recorded the assessment.
 */
export const needsAgentTurn = (session: Session): boolean => session.state._tag === 'Planning';
