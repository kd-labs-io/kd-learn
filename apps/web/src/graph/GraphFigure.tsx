// The graph figure (plan A9, decision C1 at step 0): sigma 4 over graphology, laid out with
// ForceAtlas2 (in a Web Worker for big graphs). Loaded lazily and only in the browser: sigma needs
// WebGL 2 and the DOM. It follows the list's selection and never holds anything the list lacks, so
// when WebGL fails it shows a line of text and the screen keeps working.
//
// By default it shows the statements within two links of the selected one; "whole graph" shows
// every statement, coloured by topic. Positions are display data, never written to the log.
import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import type { GraphView } from '@kd-learn/api';
import { m } from '@kd-learn/i18n';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import Sigma from 'sigma';
import { extremityArrow } from 'sigma/rendering';
import { useEffect, useMemo, useRef, useState } from 'react';
import { relationText } from './relation';

export interface GraphFigureProps {
  readonly graph: GraphView;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}

/** Above this many statements the layout runs in a worker instead of on the main thread. */
const WORKER_FROM = 800;
const WORKER_MS = 3000;
const HEIGHT = 420;
const LABEL_CHARS = 48;
/** Topic colours: theme tokens, read at draw time so they follow the theme. */
const TOPIC_TOKENS = [
  '--color-accent',
  '--color-info',
  '--color-success',
  '--color-warning',
  '--color-error',
  '--color-text-secondary',
];

/**
 * A theme colour as `rgba(...)`, which sigma parses. The token may be `light-dark()`, `oklch()` or
 * another variable: a probe element resolves it, a 1x1 canvas turns the result into sRGB bytes.
 */
const resolveColor = (host: HTMLElement, token: string, fallback: string): string => {
  const probe = document.createElement('span');
  probe.style.color = `var(${token}, ${fallback})`;
  host.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return fallback;
  context.fillStyle = fallback;
  context.fillStyle = computed;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a ?? 255) / 255})`;
};

const short = (text: string) =>
  text.length <= LABEL_CHARS ? text : `${text.slice(0, LABEL_CHARS - 1)}…`;

/** A stable start position per id, so the layout is the same on every open. */
const seed = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const a = ((h >>> 0) % 10000) / 10000;
  const b = ((Math.imul(h, 48271) >>> 0) % 10000) / 10000;
  return { x: a * 100, y: b * 100 };
};

/** Ids within `hops` links of `from`, either direction. */
const around = (graph: GraphView, from: string, hops: number): Set<string> => {
  const near = new Map<string, string[]>();
  for (const e of graph.edges) {
    near.set(e.from, [...(near.get(e.from) ?? []), e.to]);
    near.set(e.to, [...(near.get(e.to) ?? []), e.from]);
  }
  const seen = new Set([from]);
  let frontier = [from];
  for (let i = 0; i < hops; i++) {
    frontier = frontier.flatMap((id) => (near.get(id) ?? []).filter((n) => !seen.has(n)));
    frontier.forEach((n) => seen.add(n));
  }
  return seen;
};

export default function GraphFigure({ graph, selectedId, onSelect }: GraphFigureProps) {
  const container = useRef<HTMLElement>(null);
  const sigma = useRef<Sigma | undefined>(undefined);
  const model = useRef<Graph | undefined>(undefined);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const select = useRef(onSelect);
  select.current = onSelect;
  const [failed, setFailed] = useState(false);
  const [whole, setWhole] = useState(false);

  const topics = useMemo(
    () => [...new Set(graph.propositions.map((p) => p.topic))].sort((a, b) => a.localeCompare(b)),
    [graph.propositions],
  );

  // Build the graphology graph and the renderer when the data changes; keep known positions.
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const token = (name: string, fallback: string) => resolveColor(element, name, fallback);
    const g = new Graph({ type: 'directed', multi: true });
    for (const p of graph.propositions) {
      const known = positions.current.get(p.propositionId) ?? seed(p.propositionId);
      g.addNode(p.propositionId, {
        label: short(p.text),
        x: known.x,
        y: known.y,
        size: 6,
        color: token(TOPIC_TOKENS[topics.indexOf(p.topic) % TOPIC_TOKENS.length]!, '#888'),
      });
    }
    for (const e of graph.edges) {
      if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
      g.addEdgeWithKey(e.edgeId, e.from, e.to, {
        label: `${relationText(e.relation)}: ${e.label}`,
        size: 2,
        color: token('--color-border-emphasized', '#999'),
      });
    }
    const fresh = graph.propositions.some((p) => !positions.current.has(p.propositionId));
    let worker: FA2Layout | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (fresh && g.order > 1) {
      const settings = forceAtlas2.inferSettings(g);
      if (g.order >= WORKER_FROM) {
        worker = new FA2Layout(g, { settings });
        worker.start();
        timer = setTimeout(() => worker?.stop(), WORKER_MS);
      } else {
        forceAtlas2.assign(g, { iterations: 150, settings });
      }
    }

    let renderer: Sigma;
    try {
      renderer = new Sigma(g, element, {
        primitives: { edges: { extremities: [extremityArrow()], defaultHead: 'arrow' } },
        settings: {
          renderEdgeLabels: true,
          enableNodeDrag: true,
          // Sizes in pixels: the default ("positions") scales them with the layout's spread.
          itemSizesReference: 'screen',
          labelRenderedSizeThreshold: 4,
          // Room for the labels of nodes at the edge of the layout.
          stagePadding: 80,
          // The figure sits in a scrolling page: a plain wheel or one finger scrolls the page.
          gestureTarget: 'shared',
          allowInvalidContainer: true,
        },
      });
    } catch {
      worker?.kill();
      setFailed(true);
      return;
    }
    renderer.on('clickNode', ({ node }) => select.current(node));
    sigma.current = renderer;
    model.current = g;
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      worker?.kill();
      g.forEachNode((node, attributes) =>
        positions.current.set(node, { x: attributes['x'] as number, y: attributes['y'] as number }),
      );
      renderer.kill();
      sigma.current = undefined;
      model.current = undefined;
    };
  }, [graph, topics]);

  // What is shown: the selection and its neighbourhood, or everything.
  useEffect(() => {
    const renderer = sigma.current;
    if (renderer === undefined) return;
    const shown = whole || selectedId === undefined ? undefined : around(graph, selectedId, 2);
    for (const p of graph.propositions) {
      const id = p.propositionId;
      model.current?.setNodeAttribute(id, 'size', id === selectedId ? 11 : 6);
      renderer.setNodeState(id, {
        isHidden: shown !== undefined && !shown.has(id),
        isHighlighted: id === selectedId,
      });
    }
    for (const e of graph.edges) {
      renderer.setEdgeState(e.edgeId, {
        isHidden: shown !== undefined && !(shown.has(e.from) && shown.has(e.to)),
        isHighlighted: e.from === selectedId || e.to === selectedId,
      });
    }
    renderer.refresh();
  }, [graph, selectedId, whole, failed]);

  if (failed) {
    return (
      <Text type="supporting" data-testid="graph-figure-unavailable">
        {m.graph_figure_unavailable()}
      </Text>
    );
  }
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center" justify="between" wrap="wrap">
        <Text type="label">{m.graph_figure()}</Text>
        <HStack gap={1}>
          <Button
            label={m.graph_figure_neighbours()}
            size="sm"
            variant={whole ? 'ghost' : 'primary'}
            onClick={() => setWhole(false)}
          />
          <Button
            label={m.graph_figure_all()}
            size="sm"
            variant={whole ? 'primary' : 'ghost'}
            onClick={() => setWhole(true)}
            data-testid="graph-figure-all"
          />
        </HStack>
      </HStack>
      {/* Decorative for assistive tech: the list above carries the same content. */}
      <VStack ref={container} height={HEIGHT} aria-hidden data-testid="graph-figure" />
    </VStack>
  );
}
