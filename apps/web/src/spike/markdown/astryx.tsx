// SPIKE (phase 1 step 6): candidate B, Astryx `Markdown` (streaming mode, `components.math`) plus KaTeX.
import { Markdown } from '@astryxdesign/core/Markdown';
import { memo } from 'react';
import { MathView } from './math';

function MathExpression({ value, display }: { value: string; display: 'inline' | 'block' }) {
  return <MathView tex={value} display={display === 'block'} />;
}

const components = { math: MathExpression };

export const AstryxMarkdown = memo(function AstryxMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <div data-renderer="astryx" className="spike-md">
      <Markdown isStreaming={streaming} components={components} contentWidth="100%">
        {text}
      </Markdown>
    </div>
  );
});
