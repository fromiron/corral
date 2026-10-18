import { Monitor, Moon, Sun } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { ShortcutTable } from '../CommandPalette.tsx';
import { DesktopWorkspace, desktop } from '../desktop.tsx';
import { LOCALES, type Locale, useLocale } from '../locale.tsx';
import { settingsRoute } from '../router.tsx';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { changePreferences, type Theme, usePreferences } from '../workbench/preferences.ts';
import { SettingsProjectPicker } from '../workbench/SettingsNavigation.tsx';
import { WorkFolderSection } from './FilesViews.tsx';
import { WorkspaceToolSettings } from './ProjectToolSettings.tsx';

export function SettingsLayout({ children, active }: { children: ReactNode; active: string }) {
  return (
    <div className="settings-layout flex h-full min-h-0 flex-col" data-settings-section={active}>
      {active === 'workspace' || active === 'mcp' ? <SettingsProjectPicker /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const t = useTranslations('Desktop');
  const { section = 'general' } = settingsRoute.useSearch();
  const { theme, sendKey, notify } = usePreferences();
  const { locale, setLocale } = useLocale();
  const { projectId: project } = useSettingsNavigation();
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
                <h3>{t('sendKey')}</h3>
                <p>{t('sendKeyHint')}</p>
              </div>
              <fieldset className="flex rounded-xl bg-surface p-1">
                <legend className="sr-only">{t('sendKey')}</legend>
                {(['enter', 'mod-enter'] as const).map((value) => (
                  <label
                    key={value}
                    className={`relative flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs focus-within:outline-2 focus-within:outline-accent ${sendKey === value ? 'bg-raised text-text shadow-sm' : 'text-muted'}`}
                  >
                    <input
                      type="radio"
                      name="send-key"
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                      value={value}
                      checked={sendKey === value}
                      onChange={() => changePreferences({ sendKey: value })}
                    />
                    {value === 'enter' ? t('sendEnter') : t('sendModEnter')}
                  </label>
                ))}
              </fieldset>
            </section>
            {desktop ? (
              <section className="settings-row">
                <div>
                  <h3>{t('notifySetting')}</h3>
                  <p>{t('notifyHint')}</p>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={notify}
                    onChange={(e) => changePreferences({ notify: e.target.checked })}
                  />
                  {t('notifyOn')}
                </label>
              </section>
            ) : null}
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
            <DesktopWorkspace />
          </>
        ) : section === 'workspace' ? (
          project ? (
            <>
              <WorkFolderSection projectId={project} />
              <WorkspaceToolSettings key={project} projectId={project} />
            </>
          ) : null
        ) : section === 'shortcuts' ? (
          <section className="rounded-xl bg-raised p-5">
            <ShortcutTable />
          </section>
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
