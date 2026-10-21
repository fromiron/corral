import { X } from '@corral/react/icons';
import { Button, Dialog, DialogPopup, DialogTitle, Select, Tooltip } from '@corral/react/ui';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { SETTINGS_SECTIONS, type SettingsSection, useSettingsNavigation } from './navigation.ts';
import { SettingsContent } from './SettingsContent.tsx';
import { SettingsLeavePrompt } from './SettingsLifecycle.tsx';
import { SettingsNavigation } from './SettingsNavigation.tsx';

export function SettingsDialog({
  section,
  inbox,
  currentProject,
}: {
  section: SettingsSection;
  inbox: number;
  currentProject: string;
}) {
  const navigation = useSettingsNavigation();
  const navigate = useNavigate();
  const t = useTranslations('SettingsDialog');
  const td = useTranslations('Desktop');
  const n = useTranslations('Navigation');
  const r = useTranslations('Resources');
  const h = useTranslations('Harness');
  const v = useTranslations('Vault');
  const [trigger] = useState(() => document.activeElement as HTMLElement | null);
  const projectScope = ['workspace', 'mcp', 'project-defaults'].includes(section);
  const label = (key: string) =>
    key === 'vault'
      ? v('heading')
      : key === 'defaults'
        ? n('personalDefaults')
        : key === 'project-defaults'
          ? n('projectDefaults')
          : key === 'harness'
            ? h('heading')
            : key === 'workspace'
              ? n('projectFolder')
              : ['skills', 'hooks', 'mcp'].includes(key)
                ? r(key)
                : td(key);
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        const target = details.event.target;
        if (
          !open &&
          details.reason === 'escape-key' &&
          target instanceof Element &&
          target.closest(
            '[data-slot="select-popup"], [data-slot="menu-popup"], [data-slot="popover-popup"]',
          )
        ) {
          details.cancel();
          return;
        }
        if ('isComposing' in details.event && details.event.isComposing) {
          details.cancel();
          return;
        }
        if (!open) navigation.close?.();
      }}
    >
      <DialogPopup
        data-settings-dialog
        className="settings-dialog flex h-[min(46rem,calc(100dvh-2rem))] w-full max-w-[65rem] flex-col overflow-hidden p-0 max-sm:h-[100dvh] max-sm:rounded-none"
        bottomStickOnMobile={false}
        showCloseButton={false}
        finalFocus={() =>
          trigger?.isConnected && trigger.getClientRects().length
            ? trigger
            : (document.querySelector<HTMLElement>(
                '[data-testid="chat-composer"] textarea, .app-sidebar-trigger',
              ) ?? false)
        }
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2">
          <DialogTitle>{t('title')}</DialogTitle>
          <Tooltip content={t('close')}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              onClick={() => navigation.close?.()}
            >
              <X />
            </Button>
          </Tooltip>
        </div>
        <div className="shrink-0 border-b border-line p-2 sm:hidden">
          <Select
            label={t('title')}
            value={section}
            options={SETTINGS_SECTIONS.map((value) => ({ value, label: label(value) }))}
            onValueChange={(value) => void navigate(navigation.link(value))}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 border-r border-line sm:block">
            <SettingsNavigation inbox={inbox} currentProject={currentProject} />
          </aside>
          <div className="min-w-0 flex-1">
            <SettingsContent
              key={`${section}:${projectScope ? (navigation.projectId ?? '') : ''}`}
              section={section}
            />
          </div>
        </div>
        <SettingsLeavePrompt />
      </DialogPopup>
    </Dialog>
  );
}
