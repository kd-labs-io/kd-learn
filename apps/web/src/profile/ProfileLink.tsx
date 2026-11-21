import { Item } from '@astryxdesign/core/Item';
import { m } from '@kd-learn/i18n';
import { useNavigate } from '@tanstack/react-router';

/** The way from a settings screen to the teaching profile screen. */
export function ProfileLink() {
  const navigate = useNavigate();
  return (
    <Item
      label={m.profile_link()}
      description={m.profile_link_description()}
      onClick={() => void navigate({ to: '/profile' })}
      data-testid="profile-link"
    />
  );
}
