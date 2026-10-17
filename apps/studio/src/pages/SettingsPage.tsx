import { Folder, Info, Keyboard, Monitor, Moon, Settings, Sun } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { DesktopWorkspace } from '../desktop.tsx';
import { LOCALES, type Locale, useLocale } from '../locale.tsx';
import { useCurrentProject } from '../projects.ts';
import { settingsRoute } from '../router.tsx';
import { changePreferences, type Theme, usePreferences } from '../workbench/preferences.ts';
import { WorkFolderSection } from './FilesViews.tsx';

export function SettingsLayout({ children, active }: { children: ReactNode; active: string }) {
  const t = useTranslations('Desktop');
  return (
    <div className="settings-layout flex h-full min-h-0 flex-col overflow-auto md:flex-row">
      <nav
        aria-label={t('settings')}
        className="flex shrink-0 gap-1 border-b border-line p-4 md:w-52 md:flex-col md:border-r md:border-b-0"
      >
        <h2 className="mb-4 hidden px-2 text-lg font-semibold md:block">{t('settings')}</h2>
        {(['general', 'workspace', 'shortcuts', 'about'] as const).map((section) => {
          const Icon = { general: Settings, workspace: Folder, shortcuts: Keyboard, about: Info }[
            section
          ];
          return (
            <Link
              key={section}
              to="/settings"
              search={{ section }}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${active === section ? 'bg-sidebar-selected font-medium' : 'text-muted hover:bg-raised'}`}
            >
              <Icon size={16} />
              <span>{t(section)}</span>
            </Link>
          );
        })}
        <Link
          to="/settings/models"
          className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${active === 'models' ? 'bg-sidebar-selected font-medium' : 'text-muted hover:bg-raised'}`}
        >
          <Monitor size={16} />
          {t('models')}
        </Link>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const t = useTranslations('Desktop');
  const { section = 'general' } = settingsRoute.useSearch();
  const { theme } = usePreferences();
  const { locale, setLocale } = useLocale();
  const project = useCurrentProject();
  return (
    <SettingsLayout active={section}>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 sm:p-10">
        <h2 className="text-2xl font-semibold tracking-tight">{t(section)}</h2>
        {section === 'general' ? (
          <>
            <section className="settings-row">
              <div>
                <h3>{t('appearance')}</h3>
                <p>{t('appearanceHint')}</p>
              </div>
              <fieldset className="flex rounded-xl bg-surface p-1">
                <legend className="sr-only">{t('appearance')}</legend>
                {(['system', 'light', 'dark'] as Theme[]).map((value) => {
                  const Icon = { system: Monitor, light: Sun, dark: Moon }[value];
                  return (
                    <label
                      key={value}
                      className={`relative flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-xs focus-within:outline-2 focus-within:outline-accent ${theme === value ? 'bg-raised text-text shadow-sm' : 'text-muted'}`}
                    >
                      <input
                        type="radio"
                        name="theme"
                        className="absolute inset-0 size-full cursor-pointer opacity-0"
                        value={value}
                        checked={theme === value}
                        onChange={() => changePreferences({ theme: value })}
                      />
                      <Icon size={14} />
                      {t(value)}
                    </label>
                  );
                })}
              </fieldset>
            </section>
            <section className="settings-row">
              <div>
                <h3>{t('language')}</h3>
                <p>{t('languageHint')}</p>
              </div>
              <select
                aria-label={t('language')}
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="rounded-lg border border-line bg-raised px-3 py-2 text-sm"
              >
                {LOCALES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </section>
          </>
        ) : section === 'workspace' ? (
          <>
            <DesktopWorkspace />
            <WorkFolderSection projectId={project} />
          </>
        ) : section === 'shortcuts' ? (
          <dl className="space-y-3">
            {[
              [t('search'), 'Ctrl / ⌘ K'],
              [t('send'), 'Ctrl / ⌘ Enter'],
              [t('newLine'), 'Enter'],
              [t('closeMenu'), 'Esc'],
              [t('tabNavigation'), '← →'],
            ].map(([label, key]) => (
              <div key={key} className="settings-row">
                <dt>{label}</dt>
                <dd>
                  <kbd className="rounded border border-line px-2 py-1 text-xs">{key}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="corral-mark text-xl">c</span>
              <div>
                <h3 className="text-lg font-semibold">Corral Workbench</h3>
                <p className="text-sm text-muted">{t('localFirst')}</p>
              </div>
            </div>
            <p className="text-sm text-muted">{t('aboutText')}</p>
            <Button
              variant="outline"
              render={
                <a
                  href="https://github.com/fromiron/corral/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              {t('releases')}
            </Button>
          </>
        )}
      </main>
    </SettingsLayout>
  );
}
