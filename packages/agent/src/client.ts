// The browser-safe part of `agent`: the default teaching profile and the one pure helper the client
// needs. `apps/web` imports `@kd-learn/agent/client`, so no turn loop, tool or AI port code ends up
// in the client bundle.
import type { Session } from '@kd-learn/core';

export { defaultProfile } from './profile.ts';

/**
 * True when the session needs an agent turn without learner input: the assessment is in and no
 * plan exists yet. The client starts a turn with empty input (plan A3) right after the turn that
 * recorded the assessment.
 */
export const needsAgentTurn = (session: Session): boolean => session.state._tag === 'Planning';

/** The main turn that starts without learner input: the first Prober turn, and planning. */
export const shouldAutoStart = (session: Session): boolean => {
  if (session.state._tag === 'Done') return false;
  const last = session.turns.at(-1);
  // Never after a failed or interrupted turn: a bad key would loop at the learner's cost.
  if (last === undefined) return session.state._tag === 'Probing';
  return last.status === 'completed' && needsAgentTurn(session);
};
