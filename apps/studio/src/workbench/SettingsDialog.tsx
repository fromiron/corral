import {
  Button,
  Dialog,
  DialogPopup,
  Select,
  SidebarProvider,
  Tooltip,
} from '@corral/react/design-kit';
import { X } from '@corral/react/icons';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { SETTINGS_GROUPS, type SettingsSection, useSettingsNavigation } from './navigation.ts';
import { SettingsContent } from './SettingsContent.tsx';
import { SettingsLeavePrompt } from './SettingsLifecycle.tsx';
import { SettingsNavigation, useSettingsSectionLabel } from './SettingsNavigation.tsx';

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
  const n = useTranslations('Navigation');
  const [trigger] = useState(() => document.activeElement as HTMLElement | null);
  const projectScope = ['workspace', 'mcp', 'project-defaults'].includes(section);
  const label = useSettingsSectionLabel();
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
        aria-label={t('title')}
        className="settings-dialog flex h-[min(640px,calc(100dvh-4rem))] w-full max-w-[880px] flex-col overflow-hidden p-0 max-sm:h-[100dvh] max-sm:rounded-none"
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => {
          const active = document.querySelector<HTMLElement>(
            '[data-settings-dialog] [data-sidebar="menu-button"][data-active="true"]',
          );
          return active?.getClientRects().length
            ? active
            : (document.querySelector<HTMLElement>('[data-settings-dialog] button[aria-label]') ??
                false);
        }}
        finalFocus={() =>
          trigger?.isConnected && trigger.getClientRects().length
            ? trigger
            : (document.querySelector<HTMLElement>(
                '[data-testid="chat-composer"] textarea, .app-sidebar-trigger',
              ) ?? false)
        }
      >
        <SidebarProvider persist={false} shortcut={null} width="13rem" className="h-full min-h-0">
          <div className="hidden h-full shrink-0 sm:block">
            <SettingsNavigation inbox={inbox} currentProject={currentProject} />
          </div>
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <Tooltip content={t('close')}>
              <Button
                variant="ghost"
                size="icon-compact"
                className="absolute top-3 right-3 z-10"
                aria-label={t('close')}
                onClick={() => navigation.close?.()}
              >
                <X />
              </Button>
            </Tooltip>
            <div className="flex shrink-0 flex-col gap-3 px-6 pt-5 pb-3 pr-12 sm:hidden">
              <h2 className="text-title">{t('title')}</h2>
              <Select
                label={t('title')}
                value={section}
                options={SETTINGS_GROUPS.flatMap((group) =>
                  group.items.map((value) => ({ value, label: label(value), group: n(group.id) })),
                )}
                onValueChange={(value) => void navigate(navigation.link(value))}
              />
            </div>
            <div className="min-h-0 min-w-0 flex-1">
              <SettingsContent
                key={`${section}:${projectScope ? (navigation.projectId ?? '') : ''}`}
                section={section}
              />
            </div>
          </div>
        </SidebarProvider>
        <SettingsLeavePrompt />
      </DialogPopup>
    </Dialog>
  );
}
