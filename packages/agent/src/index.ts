// Agents (plan 3.1): Prober, Teacher and side chat in phase 1. Depends on core and ports only.
export { defaultProfile, needsAgentTurn } from './client.ts';
export { runTurn, InvalidTurn, failureOf, modelName } from './turn.ts';
export type { AgentOutput, FailureInfo, TurnParams } from './turn.ts';
export { runSideChat } from './side-chat.ts';
export type { SideChatParams } from './side-chat.ts';
export { mainSystem, sideSystem, NO_INPUT } from './context.ts';
