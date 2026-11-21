// The graph figure (A9). Placeholder until sigma is wired in: renders nothing.
import type { GraphView } from '@kd-learn/api';

export interface GraphFigureProps {
  readonly graph: GraphView;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}

export default function GraphFigure(_props: GraphFigureProps) {
  return null;
}
