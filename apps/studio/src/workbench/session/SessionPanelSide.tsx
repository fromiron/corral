import {
  Button,
  fontWeights,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  TabsClosable,
  type TabsClosableHandle,
  TabsClosablePanel,
  type TabsClosableTab,
  Tooltip,
} from '@corral/react/design-kit';
import {
  FileDiff,
  FileText,
  Folder,
  History,
  Maximize2,
  Minimize2,
  Plus,
} from '@corral/react/icons';
import type { ReactNode, Ref } from 'react';
import { useTranslations } from 'use-intl';
import { maximizeAvailable, type OpenTab, type PanelState } from '../panel/model.ts';
import {
  type PanelContext,
  type PanelTab,
  type PlusItem,
  plusItems,
  type TabKey,
  tabKey,
} from '../panel/tabs.ts';

// The panel beside the conversation (features/session-panel.md): its head — the strip of tabs,
// "+" after the last one, maximize at the far right — and one panel per open tab. With no tab
// the body is the "+" list itself, under one title line.

export const PANEL_ID_PREFIX = 'session-panel';

type Kind = PanelTab['kind'];
const ICONS = { files: Folder, changes: FileDiff, run: History, artifacts: FileText } as const;
const PLUS_ICONS: Record<PlusItem, (typeof ICONS)[Kind]> = {
  files: Folder,
  changes: FileDiff,
  'run-history': History,
  artifacts: FileText,
};

/** A tab's name: 실행 #n once the run's number is known, 실행 until then. */
export function usePanelTabName(runIds: readonly string[] | null) {
  const t = useTranslations('Docking');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('SessionPanel');
  return (tab: PanelTab): { label: string; shortLabel?: string } => {
    if (tab.kind !== 'run') return { label: t(tab.kind) };
    const index = runIds?.indexOf(tab.runId) ?? -1;
    if (index < 0) return { label: t('run') };
    return {
      label: tw('runNumber', { number: index + 1 }),
      shortLabel: tp('runShort', { number: index + 1 }),
    };
  };
}

export function usePlusLabel() {
  const t = useTranslations('Docking');
  return (item: PlusItem) => t(item === 'run-history' ? 'history' : item);
}

export function SessionPanelSide({
  sessionId,
  state,
  ctx,
  strip,
  onSelect,
  onClose,
  onPlus,
  onMaximize,
  renderTab,
}: {
  sessionId: string;
  state: PanelState;
  ctx: PanelContext;
  strip: Ref<TabsClosableHandle>;
  onSelect: (key: TabKey) => void;
  onClose: (key: TabKey) => void;
  onPlus: (item: PlusItem) => void;
  onMaximize: () => void;
  renderTab: (tab: OpenTab) => ReactNode;
}) {
  const t = useTranslations('SessionPanel');
  const name = usePanelTabName(ctx.runIds);
  const plusLabel = usePlusLabel();
  const items = plusItems(ctx);
  if (state.tabs.length === 0)
    return (
      // The body's first action is this list: no strip, no "+", no maximize.
      <div className="grid h-full min-h-0 justify-center overflow-auto [grid-template-columns:min(320px,calc(100%-32px))] [grid-template-rows:max(48px,28%)_auto_1fr]">
        <div className="row-start-2 flex flex-col gap-3">
          <p
            className="text-body text-foreground"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {t('empty')}
          </p>
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const Icon = PLUS_ICONS[item];
              return (
                <li key={item}>
                  <Button
                    variant="ghost"
                    className="w-full justify-start gap-2"
                    onClick={() => onPlus(item)}
                  >
                    <Icon aria-hidden="true" />
                    {plusLabel(item)}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  const tabs: TabsClosableTab[] = state.tabs.map((tab) => ({
    id: tabKey(tab),
    icon: ICONS[tab.kind],
    ...name(tab),
  }));
  const maximized = state.presentation === 'maximized';
  const maximizeLabel = t(maximized ? 'restore' : 'maximize');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-line px-2">
        <TabsClosable
          ref={strip}
          className="min-w-0 flex-1"
          aria-label={t('tabs')}
          idPrefix={PANEL_ID_PREFIX}
          tabs={tabs}
          selectedId={state.selected}
          onSelect={(id) => onSelect(id as TabKey)}
          onClose={(id) => onClose(id as TabKey)}
          closeLabel={(tab) => t('close', { name: tab.label })}
          trailing={
            items.length > 0 ? (
              <Menu>
                <Tooltip content={t('add')}>
                  <MenuTrigger
                    render={<Button variant="ghost" size="icon-compact" aria-label={t('add')} />}
                  >
                    <Plus />
                  </MenuTrigger>
                </Tooltip>
                <MenuPopup align="start" className="w-[220px]">
                  {items.map((item) => {
                    const Icon = PLUS_ICONS[item];
                    return (
                      <MenuItem key={item} icon={Icon} onClick={() => onPlus(item)}>
                        {plusLabel(item)}
                      </MenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            ) : null
          }
          end={
            maximizeAvailable(state) ? (
              <Tooltip content={maximizeLabel}>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={maximizeLabel}
                  aria-pressed={maximized}
                  onClick={onMaximize}
                >
                  {maximized ? <Minimize2 /> : <Maximize2 />}
                </Button>
              </Tooltip>
            ) : null
          }
        />
      </div>
      {state.tabs.map((tab) => {
        const key = tabKey(tab);
        return (
          <TabsClosablePanel
            // A tab closed and opened again is a new instance: it starts fresh.
            key={`${sessionId}:${tab.instance}`}
            idPrefix={PANEL_ID_PREFIX}
            tabId={key}
            selected={key === state.selected && tab.seen}
            className="flex min-h-0 flex-1 flex-col"
          >
            {renderTab(tab)}
          </TabsClosablePanel>
        );
      })}
    </div>
  );
}
