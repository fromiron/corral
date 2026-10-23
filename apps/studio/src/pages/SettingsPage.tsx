import { Button, KitSwitch, ScrollArea, Select } from '@corral/react/design-kit';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { ShortcutTable } from '../CommandPalette.tsx';
import { DesktopAbout, DesktopWorkspace, desktop } from '../desktop.tsx';
import { LOCALES, useLocale } from '../locale.tsx';
import { useServices } from '../services.tsx';
import { formatChord, sendKeyLabel } from '../shortcuts.ts';
import { useSettingsNavigation } from '../workbench/navigation.ts';
import { changePreferences, usePreferences } from '../workbench/preferences.ts';
import { SettingsProjectPicker } from '../workbench/SettingsNavigation.tsx';
import { WorkFolderSection } from './FilesViews.tsx';
import { WorkspaceToolSettings } from './ProjectToolSettings.tsx';

export function SettingsLayout({ children, active }: { children: ReactNode; active: string }) {
  const { projectId } = useSettingsNavigation();
  const n = useTranslations('Navigation');
  const r = useTranslations('Resources');
  const projectSection = ['workspace', 'mcp', 'project-defaults'].includes(active);
  return (
    <div className="settings-layout flex h-full min-h-0 flex-col" data-settings-section={active}>
      {projectSection ? <SettingsProjectPicker /> : null}
      <ScrollArea className="min-h-0 flex-1" radius="none">
        {projectSection && !projectId ? (
          <main className="settings-content">
            <h2 className="text-title">
              {active === 'mcp'
                ? r('mcp')
                : n(active === 'workspace' ? 'projectFolder' : 'projectDefaults')}
            </h2>
            <p className="text-sm text-muted-foreground">{n('projectRequired')}</p>
          </main>
        ) : (
          children
        )}
      </ScrollArea>
    </div>
  );
}

export function SettingsPage({
  section = 'general',
}: {
  section?: 'general' | 'workspace' | 'shortcuts' | 'about';
}) {
  const t = useTranslations('Desktop');
  const { serverVersion } = useServices();
  const { theme, sendKey, notify } = usePreferences();
  const { locale, setLocale } = useLocale();
  const { projectId: project } = useSettingsNavigation();
  return (
    <SettingsLayout active={section}>
      <main className="settings-content">
        <h2 className="text-title">{t(section)}</h2>
        {/* How this form saves, said where it applies (#81 SET-S10). */}
        {section === 'general' || section === 'shortcuts' ? (
          <p data-testid="settings-save-mode" className="text-sm text-muted-foreground">
            {t('savesAutomatically')}
          </p>
        ) : null}
        {section === 'general' ? (
          <div className="flex flex-col">
            <section className="settings-row">
              <div>
                <h3>{t('appearance')}</h3>
              </div>
              <Select
                label={t('appearance')}
                value={theme}
                onValueChange={(theme) => changePreferences({ theme })}
                options={(['system', 'light', 'dark'] as const).map((value) => ({
                  value,
                  label: t(value),
                }))}
              />
            </section>
            <section className="settings-row">
              <div>
                <h3>{t('sendKey')}</h3>
                <p>{t('sendKeyHint')}</p>
                <p>
                  {t('sendCombination', {
                    send: sendKeyLabel(sendKey),
                    newline:
                      sendKey === 'enter' ? formatChord({ shift: true, key: 'Enter' }) : 'Enter',
                  })}
                </p>
              </div>
              <Select
                label={t('sendKey')}
                value={sendKey}
                onValueChange={(sendKey) => changePreferences({ sendKey })}
                options={[
                  { value: 'enter', label: t('sendEnter') },
                  { value: 'mod-enter', label: t('sendModEnter') },
                ]}
              />
            </section>

            <section className="settings-row">
              <div>
                <h3>{t('language')}</h3>
                <p>{t('languageHint')}</p>
              </div>
              <Select
                label={t('language')}
                value={locale}
                onValueChange={setLocale}
                options={LOCALES.map((l) => ({ value: l.id, label: l.name }))}
              />
            </section>
            {/* Native-only controls stay in the app menu; say where (#84). Desktop shell only:
                remote windows never get local desktop controls. */}
            {desktop ? (
              <section className="settings-row" data-testid="desktop-native-options">
                <div>
                  <h3>{t('nativeHeading')}</h3>
                  <p>{t('nativeHint')}</p>
                </div>
              </section>
            ) : null}
            {desktop ? (
              <section className="settings-row">
                <div>
                  <h3>{t('notifySetting')}</h3>
                  <p>{t('notifyHint')}</p>
                </div>
                <KitSwitch
                  label={t('notifyOn')}
                  checked={notify}
                  onToggle={() => changePreferences({ notify: !notify })}
                  className="[&>span:last-child]:sr-only"
                />
              </section>
            ) : null}
            <DesktopWorkspace />
          </div>
        ) : section === 'workspace' ? (
          project ? (
            <>
              <WorkFolderSection key={`folder:${project}`} projectId={project} />
              <WorkspaceToolSettings key={`tools:${project}`} projectId={project} />
            </>
          ) : null
        ) : section === 'shortcuts' ? (
          <section>
            <ShortcutTable editable />
          </section>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{t('aboutText')}</p>
            <DesktopAbout serverVersion={serverVersion} />
            <Button
              variant="tertiary"
              className="self-start"
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
