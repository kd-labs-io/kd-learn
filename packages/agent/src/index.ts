// Agents (plan 3.1): Prober, Teacher and side chat in phase 1. Depends on core and ports only.
export { defaultProfile, needsAgentTurn, resolveProfile } from './client.ts';
export { runTurn, InvalidTurn, failureOf, modelName } from './turn.ts';
export type { AgentOutput, FailureInfo, TurnParams } from './turn.ts';
export { runSideChat } from './side-chat.ts';
export type { SideChatParams } from './side-chat.ts';
export { mainSystem, sideSystem, NO_INPUT } from './context.ts';
export { gradeExercise, writeExercises } from './practice/practitioner.ts';
export type {
  GradeParams,
  GradeResult,
  PracticeUsage,
  WriteParams,
  WrittenExercise,
} from './practice/practitioner.ts';
export {
  Audited,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  ExtractionModelFailed,
  Extracted,
  InvalidExtraction,
  Merged,
  runExtraction,
  transcript,
} from './extraction.ts';
export type {
  ExtractionError,
  ExtractionParams,
  ExtractionResult,
  ExtractionUsage,
} from './extraction.ts';
export {
  MAX_RESEARCH_QUESTION_LENGTH,
  Queries,
  RESEARCH_MAX_OUTPUT_TOKENS,
  RESEARCH_MAX_QUERIES,
  RESEARCH_MAX_RESULTS,
  RESEARCH_MODEL_CALLS,
  ResearchFailed,
  researchTitle,
  resolveResultLabels,
  runResearch,
  searchErrorFailure,
} from './research.ts';
export type { ResearchParams, ResearchResult, ResearchUsage } from './research.ts';
