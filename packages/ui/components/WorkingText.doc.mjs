/** @type {import('@astryxdesign/cli/authoring').ComponentDoc} */
export default {
  type: 'component',
  name: 'WorkingText',
  displayName: 'WorkingText',
  import: '@kd-learn/ui/components/WorkingText',
  usage: {
    description:
      'A task that is running (writing, grading, extracting): pulsing dots and a shimmering label. Use it instead of a small Spinner with a label.',
  },
  props: [
    { name: 'label', type: 'string', required: true, description: 'What is happening.' },
    {
      name: 'showLabel',
      type: 'boolean',
      default: 'true',
      description: '`false` shows only the dots; the label is still read by screen readers.',
    },
  ],
};
