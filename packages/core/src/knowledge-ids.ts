// Ids and the edge relation of the knowledge graph. A module of its own so the exercise schemas
// and the knowledge events can both use them without importing each other.
import { Schema } from 'effect';

export const PropositionId = Schema.NonEmptyString;
export type PropositionId = typeof PropositionId.Type;

export const EdgeId = Schema.NonEmptyString;
export type EdgeId = typeof EdgeId.Type;

/**
 * Relation of an edge, read as "from RELATION to" (fixed in step 1):
 * - `requires`: from needs to be understood first, so `to` comes before `from`;
 * - `implies`: from logically leads to `to`, so `from` comes before `to`;
 * - `supports`: from is evidence or a reason for `to`;
 * - `exampleOf`: from is an instance of `to`;
 * - `contrastsWith`: the two are commonly confused. Undirected: both directions are one edge.
 * `requires` and `implies` are the ordered relations: together they must stay acyclic, and a
 * reasoning chain is a path along them.
 */
export const Relation = Schema.Literals([
  'requires',
  'implies',
  'supports',
  'exampleOf',
  'contrastsWith',
]);
export type Relation = typeof Relation.Type;
