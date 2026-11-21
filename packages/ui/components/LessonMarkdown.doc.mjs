/** @type {import('@astryxdesign/cli/authoring').ComponentDoc} */
export default {
  type: 'component',
  name: 'LessonMarkdown',
  displayName: 'LessonMarkdown',
  import: '@kd-learn/ui/components/LessonMarkdown',
  usage: {
    description:
      'Renders text written by the tutor model: Markdown with KaTeX math, safe for untrusted input. HTML is escaped, remote images are never loaded (the alt text shows instead), and only absolute http(s) links are links.',
  },
  props: [
    {
      name: 'children',
      type: 'string',
      required: true,
      description: 'Markdown text. Use `$...$` for inline math and `$$...$$` for display math.',
    },
    {
      name: 'isStreaming',
      type: 'boolean',
      default: 'false',
      description: 'True while text is still arriving, so unfinished syntax is held back.',
    },
  ],
};
