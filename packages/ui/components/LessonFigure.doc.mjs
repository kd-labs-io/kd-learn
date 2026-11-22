/** @type {import('@astryxdesign/cli/authoring').ComponentDoc} */
export default {
  type: 'component',
  name: 'LessonFigure',
  displayName: 'LessonFigure',
  import: '@kd-learn/ui/components/LessonFigure',
  usage: {
    description:
      'A Teacher message with figures: Markdown text, and each [[figure:id]] marker as an SVG or Mermaid image, a sandboxed HTML demo (runs on click) or a generated image.',
  },
  props: [
    {
      name: 'children',
      type: 'string',
      required: true,
      description: 'Message text with figure markers. Untrusted.',
    },
    {
      name: 'figures',
      type: 'ReadonlyMap<string, FigureInfo>',
      required: true,
      description: 'Figures of the message, from FigureAdded events.',
    },
    {
      name: 'loadBody',
      type: '(figureId: string) => Promise<string | Uint8Array | undefined>',
      required: true,
      description: 'Reads one figure body.',
    },
    {
      name: 'vars',
      type: 'FigureVars',
      required: true,
      description: 'Figure colors of the current theme (figureVars from @kd-learn/tokens).',
    },
    {
      name: 'isStreaming',
      type: 'boolean',
      default: 'false',
      description:
        'True while the text is still arriving: markers without a figure show a placeholder.',
    },
  ],
};
