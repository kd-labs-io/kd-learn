// Mermaid figures (plan A4, spike C2): rendered in the app, loaded lazily, strict, without HTML
// labels; the SVG it returns then goes through `prepareSvg` and is shown as an image. Mermaid holds
// global state (its config), so renders run one at a time.
import type { FigureVars } from '@kd-learn/tokens';

let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

export const renderMermaid = (code: string, vars: FigureVars): Promise<string> => {
  const run = async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      layout: 'dagre',
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: {
        background: vars['--kd-bg'],
        primaryColor: vars['--kd-bg'],
        primaryTextColor: vars['--kd-fg'],
        primaryBorderColor: vars['--kd-accent'],
        secondaryColor: vars['--kd-bg'],
        tertiaryColor: vars['--kd-bg'],
        lineColor: vars['--kd-muted'],
        textColor: vars['--kd-fg'],
        mainBkg: vars['--kd-bg'],
        nodeBorder: vars['--kd-accent'],
        clusterBkg: vars['--kd-bg'],
        titleColor: vars['--kd-fg'],
        edgeLabelBackground: vars['--kd-bg'],
        pie1: vars['--kd-cat-1'],
        pie2: vars['--kd-cat-2'],
        pie3: vars['--kd-cat-3'],
        pie4: vars['--kd-cat-4'],
        pie5: vars['--kd-cat-5'],
        pie6: vars['--kd-cat-6'],
        fontFamily: 'system-ui, sans-serif',
      },
    });
    await mermaid.parse(code);
    const { svg } = await mermaid.render(`kd-mermaid-${++counter}`, code);
    return svg;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
};
