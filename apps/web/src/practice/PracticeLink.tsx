import { Item } from '@astryxdesign/core/Item';
import { m } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';

/** The way from home to the practice screen. */
export function PracticeLink() {
  const navigate = useNavigate();
  return (
    <Item
      label={m.practice_link()}
      description={m.practice_link_description()}
      onClick={() => void navigate({ to: '/practice' })}
      data-testid="practice-link"
    />
  );
}
