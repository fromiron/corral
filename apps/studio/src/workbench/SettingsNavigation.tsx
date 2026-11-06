import {
  Button,
  DialogTitle,
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
  ArrowLeft,
  BookOpen,
  Bot,
  FolderOpen,
  GitBranch,
  Inbox,
  Info,
  Keyboard,
  LayoutGrid,
  PanelLeft,
  Settings,
  Shield,
  Terminal,
  Users,
} from '@corral/react/icons';
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
  const sidebar = (
    <nav data-testid="settings-sidebar" aria-label={td('settings')} className="h-full min-h-0">
      <Sidebar
        collapsible="none"
        rail={false}
        bordered={false}
        className="h-full bg-[rgb(var(--overlay)/0.03)]"
      >
        <SidebarHeader className="gap-3 px-4 pt-5 pb-2">
          {navigation.overlay ? (
            <DialogTitle className="text-title font-normal">{td('settings')}</DialogTitle>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Link
                  to={navigation.returnTo}
                  resetScroll={false}
                  className="mr-auto flex min-w-0 items-center gap-2 rounded-md py-1 text-body text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft size={16} />
                  {t('backToWork')}
                </Link>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={w('collapseSidebar')}
                  onClick={() => changePreferences({ sidebarOpen: false })}
                >
                  <PanelLeft />
                </Button>
              </div>
              <h2 className="text-title">{td('settings')}</h2>
            </>
          )}
        </SidebarHeader>
        <SidebarContent>
          {SETTINGS_GROUPS.map((group) => (
            <SidebarGroup key={group.id} aria-label={t(group.id)}>
              <SidebarGroupLabel>{t(group.id)}</SidebarGroupLabel>
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
        placeholder={t('chooseProject')}
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
