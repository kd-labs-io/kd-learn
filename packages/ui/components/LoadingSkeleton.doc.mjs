/** @type {import('@astryxdesign/cli/authoring').ComponentDoc} */
export default {
  type: 'component',
  name: 'LoadingSkeleton',
  displayName: 'LoadingSkeleton',
  import: '@kd-learn/ui/components/LoadingSkeleton',
  usage: {
    description:
      'Shimmer placeholder for content that is loading: `text` for a page or panel, `list` for a list of rows. Use it instead of a Spinner with text.',
  },
  props: [
    {
      name: 'label',
      type: 'string',
      required: true,
      description: 'What is loading, read by screen readers.',
    },
    {
      name: 'variant',
      type: "'text' | 'list'",
      default: "'text'",
      description: '`text`: heading and lines. `list`: stacked rows.',
    },
    { name: 'rows', type: 'number', default: '3', description: 'Number of lines or rows.' },
  ],
};
