import { type ErrorComponentProps, Link, Outlet, useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { CommandLayer, modKey } from '../CommandPalette.tsx';
import { LOCALES, type Locale, useLocale } from '../locale.tsx';
import { useServices } from '../services.tsx';

export function RootLayout() {
  const t = useTranslations('Studio');
  const tp = useTranslations('CommandPalette');
  const { mode, live } = useServices();
  const { locale, setLocale } = useLocale();
  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised px-4 py-2">
        <nav className="flex items-center gap-4">
          <h1 className="text-base font-semibold">{t('title')}</h1>
          <Link to="/" className="text-sm underline-offset-4 hover:underline">
            {t('nav')}
          </Link>
          {mode === 'server' ? (
            <Link to="/settings/models" className="text-sm underline-offset-4 hover:underline">
              {t('navModels')}
            </Link>
          ) : null}
        </nav>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
          }
          className="flex items-center gap-2 rounded-md border border-line px-2 py-1 text-xs text-muted"
        >
          {tp('button')}
          <kbd className="font-mono">{modKey()} K</kbd>
        </button>
        <label className="flex items-center gap-1 text-xs text-muted">
          <span>{t('language')}</span>
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
            className="rounded border border-line bg-surface px-1 py-0.5 text-text"
          >
            {LOCALES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-warning px-2 py-0.5 font-semibold text-warning">
            {mode === 'server' ? (live ? t('liveBadge') : t('serverBadge')) : t('demoBadge')}
          </span>
          <span className="text-muted">
            {mode === 'server' ? (live ? t('liveNote') : t('serverNote')) : t('demoNote')}
          </span>
        </p>
      </header>
      <div className="min-h-0">
        <Outlet />
      </div>
      <CommandLayer />
    </div>
  );
}

export function NotFoundView() {
  const t = useTranslations('Studio');
  return (
    <main className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-lg font-semibold">{t('notFound')}</h2>
      <Link to="/" className="text-sm underline">
        {t('backToCorrals')}
      </Link>
    </main>
  );
}

export function ErrorView({ error }: ErrorComponentProps) {
  const t = useTranslations('Studio');
  const router = useRouter();
  return (
    <main role="alert" className="flex flex-col items-start gap-3 p-6">
      <h2 className="text-lg font-semibold">
        {t('error', { message: error instanceof Error ? error.message : String(error) })}
      </h2>
      <button
        type="button"
        onClick={() => router.invalidate()}
        className="rounded border border-line px-2 py-1 text-sm"
      >
        ↻
      </button>
      <Link to="/" className="text-sm underline">
        {t('backToCorrals')}
      </Link>
    </main>
  );
}

/** Server mode without a session: nothing can be read, so say how to get one. */
export function SessionMissingView() {
  const t = useTranslations('Studio');
  return (
    <main className="flex flex-col items-start gap-3 p-6">
      <h1 className="text-base font-semibold">{t('title')}</h1>
      <p role="alert" className="text-sm text-danger">
        {t('sessionMissing')}
      </p>
    </main>
  );
}
