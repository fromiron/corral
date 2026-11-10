import {
  cn,
  DialogTitle,
  fontWeights,
  Select,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@corral/react/design-kit';
import {
  Activity,
  BookOpen,
  Bot,
  FolderOpen,
  GitBranch,
  Inbox,
  Info,
  Keyboard,
  LayoutGrid,
  Settings,
  Shield,
  Terminal,
  Users,
} from '@corral/react/icons';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslations } from 'use-intl';
import { projectName } from '../projects.ts';
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSection,
  useSettingsNavigation,
} from './navigation.ts';

export function settingsSection(path: string, section?: unknown): string {
  const value = path !== '/settings' ? path.split('/')[2] : section;
  return typeof value === 'string' && SETTINGS_SECTIONS.includes(value as SettingsSection)
    ? value
    : 'general';
}

const SECTION_ICONS = {
  general: Settings,
  shortcuts: Keyboard,
  about: Info,
  workspace: FolderOpen,
  models: Bot,
  vault: Shield,
  harness: Terminal,
  skills: BookOpen,
  hooks: GitBranch,
  mcp: LayoutGrid,
  defaults: Settings,
  'project-defaults': Users,
  diagnostics: Activity,
} satisfies Record<SettingsSection, typeof Settings>;

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
  const nav = useRef<HTMLElement>(null);
  // The list scrolls on its own (its edges fade); the current section is always in view.
  useEffect(() => {
    void active;
    nav.current
      ?.querySelector<HTMLElement>('[data-sidebar="menu-button"][data-active="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  // `/settings/*` replaces into the dialog (#88), so the header holds only the title.
  const sidebar = (
    <nav
      ref={nav}
      data-testid="settings-sidebar"
      aria-label={td('settings')}
      className="h-full min-h-0"
    >
      <Sidebar
        collapsible="none"
        rail={false}
        bordered={false}
        className="h-full bg-[rgb(var(--overlay)/0.03)]"
      >
        <SidebarHeader className="gap-3 px-4 pt-5 pb-2">
          {navigation.overlay ? (
            // Normal weight, as the kit's, so the title does not out-shout the sections.
            <DialogTitle
              className="text-title"
              style={{ fontVariationSettings: fontWeights.normal }}
            >
              {td('settings')}
            </DialogTitle>
          ) : (
            <h2 className="text-title" style={{ fontVariationSettings: fontWeights.normal }}>
              {td('settings')}
            </h2>
          )}
        </SidebarHeader>
        <SidebarContent>
          {SETTINGS_GROUPS.map((group) => (
            <SidebarGroup key={group.id} aria-label={t(group.id)}>
              <SidebarGroupLabel>{t(group.id)}</SidebarGroupLabel>
              {/* The one place the settings target project is chosen (#80). */}
              {group.id === 'project' ? <SettingsProjectPicker className="px-2 pb-2" /> : null}
              <SidebarMenu focusRing={false}>
                {group.items.map((key) => (
                  <SidebarMenuItem key={key}>
                    <SidebarMenuButton
                      icon={SECTION_ICONS[key]}
                      isActive={active === key}
                      render={
                        <Link
                          {...navigation.link(key)}
                          activeOptions={{ exact: true, includeSearch: true, includeHash: true }}
                          activeProps={{ 'aria-current': active === key ? 'page' : undefined }}
                          inactiveProps={{ 'aria-current': active === key ? 'page' : undefined }}
                        />
                      }
                    >
                      {label(key)}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </SidebarContent>
        {inbox > 0 ? (
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  icon={Inbox}
                  className="text-warning"
                  render={<Link to="/projects/$projectId" params={{ projectId: currentProject }} />}
                >
                  {w('needsYou', { count: inbox })}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        ) : null}
      </Sidebar>
    </nav>
  );
  return navigation.overlay ? (
    sidebar
  ) : (
    <SidebarProvider persist={false} shortcut={null} width="100%" className="h-full min-h-0">
      {sidebar}
    </SidebarProvider>
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

/**
 * "Settings for: <project>". This changes the settings target, not the current work location,
 * and it is the only project choice in settings.
 */
export function SettingsProjectPicker({ className }: { className?: string }) {
  const t = useTranslations('Navigation');
  const p = useTranslations('Projects');
  const navigation = useSettingsNavigation();
  const navigate = useNavigate();
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {/* Full-contrast text: the tinted settings sidebar leaves muted text below 4.5:1. */}
      <span aria-hidden="true" className="text-caption text-foreground">
        {t('settingsFor')}
      </span>
      <Select
        label={t('settingsFor')}
        value={navigation.projectId ?? ''}
        placeholder={t('chooseProject')}
        className="w-full"
        options={[
          ...(navigation.projectId ? [] : [{ value: '', label: t('chooseProject') }]),
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
