/** @type {import('@astryxdesign/cli/authoring').ComponentDoc} */
export default {
  type: 'component',
  name: 'LessonText',
  displayName: 'LessonText',
  import: '@kd-learn/ui/components/LessonText',
  usage: {
    description:
      'Body text of a lesson step at a readable 68ch measure. Use the callout variant for a key idea.',
  },
  props: [
    {
      name: 'children',
      type: 'ReactNode',
      required: true,
      description: 'Lesson content: paragraphs, lists, code.',
    },
    {
      name: 'variant',
      type: "'plain' | 'callout'",
      default: "'plain'",
      description: '`callout` puts the text on a surface with the decorative accent rule.',
    },
  ],
};
