import { Button, fontWeights, KitSwitch, Select } from '@corral/react/design-kit';
import { type ReactNode, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ShortcutTable } from '../CommandPalette.tsx';
import { DesktopAbout, DesktopWorkspace, desktop } from '../desktop.tsx';
import { LOCALES, useLocale } from '../locale.tsx';
import { useServices } from '../services.tsx';
import { formatChord, sendKeyLabel } from '../shortcuts.ts';
import { type SettingsSection, useSettingsNavigation } from '../workbench/navigation.ts';
import { changePreferences, usePreferences } from '../workbench/preferences.ts';
import { useSettingsSectionLabel } from '../workbench/SettingsNavigation.tsx';
import { AppearanceSettings, type ThemeListFocus } from './AppearanceSettings.tsx';
import { WorkFolderSection } from './FilesViews.tsx';
import { WorkspaceToolSettings } from './ProjectToolSettings.tsx';
import { SettingsScroll } from './SettingsScroll.tsx';
import { ThemeEditor, type ThemeEditorTarget } from './ThemeEditor.tsx';

/**
 * The settings dialog's content frame: one heading named after the section, an optional line for
 * a fact the controls cannot show, then the section's own scrolling content. Pages never draw
 * their own title (the kit's settings panel: title, description, scrolling body).
 */
export function SettingsLayout({
  children,
  active,
  description,
  descriptionId,
  scroll = true,
}: {
  children: ReactNode;
  active: SettingsSection;
  /** One line, only where it says something the controls cannot. */
  description?: ReactNode;
  /** A test or link target for the description line. */
  descriptionId?: string;
  /** False for a sub-view that keeps its own head above its own scrolling body. */
  scroll?: boolean;
}) {
  const { projectId } = useSettingsNavigation();
  const n = useTranslations('Navigation');
  const label = useSettingsSectionLabel();
  const projectSection = ['workspace', 'mcp', 'project-defaults'].includes(active);
  const needsProject = projectSection && !projectId;
  return (
    <div className="settings-layout flex h-full min-h-0 flex-col" data-settings-section={active}>
      {/* Narrow screens name the section in the dialog's own selector above. */}
      <header
        data-settings-header
        className="flex shrink-0 flex-col gap-1 px-6 pt-5 pr-12 pb-4 max-sm:pt-0"
      >
        <h2
          className="text-title text-foreground max-sm:sr-only"
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          {label(active)}
        </h2>
        {needsProject ? (
          <p className="text-body text-muted-foreground">{n('projectRequired')}</p>
        ) : description ? (
          <p data-testid={descriptionId} className="text-body text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>
      {scroll ? (
        <SettingsScroll className="min-h-0 flex-1">{needsProject ? null : children}</SettingsScroll>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{needsProject ? null : children}</div>
      )}
    </div>
  );
}

export function SettingsPage({
  section = 'general',
}: {
  section?: 'general' | 'workspace' | 'shortcuts' | 'about';
}) {
  const t = useTranslations('Desktop');
  const tp = useTranslations('Preferences');
  const { serverVersion } = useServices();
  const prefs = usePreferences();
  const { sendKey, notify, density } = prefs;
  const { locale, setLocale } = useLocale();
  const { projectId: project } = useSettingsNavigation();
  // The personal theme editor opens in place of General, with its own head and scrolling body.
  const [editing, setEditing] = useState<{
    target: ThemeEditorTarget;
    opener: ThemeListFocus;
  } | null>(null);
  const [returnFocus, setReturnFocus] = useState<ThemeListFocus | null>(null);
  if (section === 'general' && editing)
    return (
      <SettingsLayout active={section} scroll={false}>
        <ThemeEditor
          target={editing.target}
          onClose={() => {
            setReturnFocus(editing.opener);
            setEditing(null);
          }}
        />
      </SettingsLayout>
    );
  return (
    <SettingsLayout active={section}>
      <main className="settings-content">
        {section === 'general' ? (
          <div className="flex flex-col">
            <AppearanceSettings
              onEdit={(target, opener) => setEditing({ target, opener })}
              focus={returnFocus}
              onFocused={() => setReturnFocus(null)}
            />
            <section className="settings-row">
              <div>
                <h3>{tp('density')}</h3>
              </div>
              <Select
                label={tp('density')}
                value={density}
                onValueChange={(density) => changePreferences({ density })}
                options={[
                  { value: 'default', label: tp('densityDefault') },
                  { value: 'compact', label: tp('densityCompact') },
                ]}
              />
            </section>
            <section className="settings-row">
              <div>
                <h3>{t('sendKey')}</h3>
                {/* The one place the other key is named. */}
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
              </div>
              <Select
                label={t('language')}
                value={locale}
                onValueChange={setLocale}
                options={LOCALES.map((l) => ({ value: l.id, label: l.name }))}
              />
            </section>
            {/* Desktop shell only: remote windows never get local desktop controls. */}
            {desktop ? (
              <section className="settings-row">
                <div>
                  <h3>{t('notifyOn')}</h3>
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
