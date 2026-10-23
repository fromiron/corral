import { ArrowLeft, Inbox, PanelLeft } from '@corral/react/icons';
import { Button, Select } from '@corral/react/ui';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { projectName } from '../projects.ts';
import { SETTINGS_GROUPS, type SettingsSection, useSettingsNavigation } from './navigation.ts';
import { changePreferences } from './preferences.ts';

export function settingsSection(path: string, section?: unknown): string {
  const value = path !== '/settings' ? path.split('/')[2] : section;
  return typeof value === 'string' &&
    [
      'general',
      'shortcuts',
      'about',
      'workspace',
      'models',
      'vault',
      'harness',
      'skills',
      'hooks',
      'mcp',
      'defaults',
      'project-defaults',
    ].includes(value)
    ? value
    : 'general';
}

export function SettingsNavigation({
  inbox,
  currentProject,
}: {
  inbox: number;
  currentProject: string;
}) {
  const t = useTranslations('Navigation');
  const td = useTranslations('Desktop');
  const w = useTranslations('Workbench');
  const navigation = useSettingsNavigation();
  const location = useRouterState({ select: (state) => state.location });
  const active = navigation.section ?? settingsSection(location.pathname, location.search.section);
  const label = useSettingsSectionLabel();
  const sections = SETTINGS_GROUPS.map((group) => ({ title: t(group.id), items: group.items }));
  return (
    <nav
      data-testid="settings-sidebar"
      aria-label={td('settings')}
      className="flex h-full min-h-0 flex-col bg-sidebar text-sm"
    >
      {!navigation.overlay ? (
        <div className="flex h-[52px] shrink-0 items-center border-b border-line/50 px-4">
          <Link
            to={navigation.returnTo}
            resetScroll={false}
            className="mr-auto flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-ui hover:bg-sidebar-accent"
          >
            <ArrowLeft size={16} />
            {t('backToWork')}
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={w('collapseSidebar')}
            onClick={() => changePreferences({ sidebarOpen: false })}
          >
            <PanelLeft />
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {sections.map((group) => (
          <section key={group.title} className="mb-5" aria-label={group.title}>
            <h2 className="mb-2 px-3 text-2xs font-medium text-muted">{group.title}</h2>
            {group.items.map((key) => (
              <Link
                key={key}
                {...navigation.link(key)}
                activeOptions={{ exact: true, includeSearch: true, includeHash: true }}
                inactiveProps={{ 'aria-current': undefined }}
                aria-current={active === key ? 'page' : undefined}
                className={`mb-1 block rounded-md px-3 py-2 text-ui ${active === key ? 'bg-sidebar-selected font-medium text-text' : 'text-muted hover:bg-sidebar-accent hover:text-text'}`}
              >
                {label(key)}
              </Link>
            ))}
          </section>
        ))}
      </div>
      {inbox > 0 ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: currentProject }}
          className="flex items-center gap-2 border-t border-line/50 p-4 text-warning"
        >
          <Inbox size={16} />
          {w('needsYou', { count: inbox })}
        </Link>
      ) : null}
    </nav>
  );
}

/** A settings section's name, the same in the sidebar, the narrow menu and the page. */
export function useSettingsSectionLabel() {
  const t = useTranslations('Navigation');
  const td = useTranslations('Desktop');
  const h = useTranslations('Harness');
  const r = useTranslations('Resources');
  const v = useTranslations('Vault');
  return (key: SettingsSection) =>
    key === 'vault'
      ? v('heading')
      : key === 'project-defaults'
        ? t('projectDefaults')
        : key === 'defaults'
          ? t('personalDefaults')
          : key === 'harness'
            ? h('heading')
            : key === 'workspace'
              ? t('projectFolder')
              : key === 'skills' || key === 'hooks' || key === 'mcp'
                ? r(key)
                : td(key);
}

/** This changes the settings target, not the current work location. */
export function SettingsProjectPicker({
  label,
  disabled = false,
  className = 'border-b border-line/60 px-6 py-3 sm:px-10',
}: {
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('Navigation');
  const p = useTranslations('Projects');
  const navigation = useSettingsNavigation();
  const navigate = useNavigate();
  return (
    <div className={className}>
      {/* A visible scope, so choosing here reads as a settings target, not navigation (#80). */}
      {label ? null : (
        <p className="mb-1.5 text-xs font-medium text-foreground">{t('settingsTarget')}</p>
      )}
      <Select
        label={label ?? t('appliesToProject')}
        disabled={disabled}
        value={navigation.projectId ?? ''}
        options={[
          { value: '', label: t('chooseProject') },
          ...navigation.projects.map((project) => ({
            value: project.projectId,
            label: projectName(project, p('defaultName')),
          })),
        ]}
        onValueChange={(projectId) =>
          navigation.selectProject
            ? navigation.selectProject(projectId)
            : void navigate({
                to: '.',
                search: (previous) => ({
                  ...previous,
                  ...navigation.search,
                  projectId: projectId || undefined,
                }),
              })
        }
      />
    </div>
  );
}
