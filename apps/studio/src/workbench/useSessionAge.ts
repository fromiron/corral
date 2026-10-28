import { useFormatter, useNow, useTranslations } from 'use-intl';

export function useSessionAge() {
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const t = useTranslations('Sessions');
  return (iso: string) =>
    now.getTime() - Date.parse(iso) < 60_000
      ? t('justNow')
      : format.relativeTime(new Date(iso), now);
}
