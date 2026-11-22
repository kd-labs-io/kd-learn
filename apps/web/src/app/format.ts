import { getLocaleTag } from '@kd-learn/i18n';

export const formatDate = (epochMs: number) =>
  new Intl.DateTimeFormat(getLocaleTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    epochMs,
  );
