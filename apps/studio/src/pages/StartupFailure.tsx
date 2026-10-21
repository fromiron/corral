import { Button } from '@corral/react/ui';
import { useTranslations } from 'use-intl';

export function StartupFailure() {
  const t = useTranslations('Studio');
  return (
    <main className="flex min-h-dvh flex-col items-start justify-center gap-4 p-6">
      <h1 className="text-base font-semibold">{t('title')}</h1>
      <p role="alert" className="max-w-lg text-sm text-danger">
        {t('connectionFailed')}
      </p>
      <Button onClick={() => window.location.reload()}>{t('retryConnection')}</Button>
    </main>
  );
}
