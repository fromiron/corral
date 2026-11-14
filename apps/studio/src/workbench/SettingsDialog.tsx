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
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SETTINGS_GROUPS, type SettingsSection, useSettingsNavigation } from './navigation.ts';
import { SettingsContent } from './SettingsContent.tsx';
import { SettingsLeavePrompt } from './SettingsLifecycle.tsx';
import {
  SettingsNavigation,
  SettingsProjectPicker,
  useSettingsSectionLabel,
} from './SettingsNavigation.tsx';

const FOCUS_FALLBACKS = [
  '[data-testid="chat-composer"] textarea',
  '[role="tab"][aria-selected="true"]',
  '.app-sidebar-trigger',
];

/** Where focus goes when what opened settings is gone: the first of these that can be seen. */
function fallbackFocus() {
  for (const selector of FOCUS_FALLBACKS)
    for (const element of document.querySelectorAll<HTMLElement>(selector))
      if (!element.closest('[data-settings-dialog]') && element.getClientRects().length)
        return element;
  return null;
}

/**
 * What opened settings can leave just after it closes, once the screen reads what was saved (a
 * connect notice, an empty state's link). For a moment after closing, focus that fell to the
 * page is handed to the screen instead.
 */
function keepFocusAfterClose() {
  let checks = 0;
  const timer = setInterval(() => {
    checks += 1;
    if (document.activeElement !== document.body) {
      // Still on the opener, or the person moved it: nothing to do unless the opener leaves.
      if (checks >= 15) clearInterval(timer);
      return;
    }
    clearInterval(timer);
    if (!document.querySelector('[data-settings-dialog]'))
      fallbackFocus()?.focus({ preventScroll: true });
  }, 100);
}

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
  useEffect(() => keepFocusAfterClose, []);
  const projectScope = ['workspace', 'mcp', 'project-defaults'].includes(section);
  // Sections that read the settings target project; on a narrow screen the picker joins them.
  const projectTarget = projectScope || section === 'harness' || section === 'diagnostics';
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
        className="settings-dialog flex h-[min(820px,90dvh)] w-[min(1120px,94vw)] max-w-none flex-col overflow-hidden p-0 max-sm:h-[100dvh] max-sm:w-full max-sm:rounded-none"
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
            : (fallbackFocus() ?? false)
        }
      >
        {/* Wide enough that no section name is cut, in English or Korean. */}
        <SidebarProvider persist={false} shortcut={null} width="15.5rem" className="h-full min-h-0">
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
              {projectTarget ? <SettingsProjectPicker /> : null}
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
