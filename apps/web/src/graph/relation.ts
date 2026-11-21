import type { Relation } from '@kd-learn/core';
import { m } from '@kd-learn/i18n';

/** How an edge reads, "from RELATION to". */
export const relationText = (relation: Relation) => {
  switch (relation) {
    case 'requires':
      return m.graph_relation_requires();
    case 'implies':
      return m.graph_relation_implies();
    case 'supports':
      return m.graph_relation_supports();
    case 'exampleOf':
      return m.graph_relation_exampleOf();
    case 'contrastsWith':
      return m.graph_relation_contrastsWith();
  }
};
