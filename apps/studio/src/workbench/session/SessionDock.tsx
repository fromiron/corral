// The bottom dock's screen (features/session-panel.md 하단 도크): a head with its strip of
// terminal and debug tabs and the "+" after the last one, then the selected tab, or with no tab
// the reason line an empty dock shows. What the dock holds is the page's state (panel/dock.ts).
import type { TerminalView } from '@corral/contracts';
import {
  Button,
  LiveDot,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  TabsClosable,
  type TabsClosableHandle,
  TabsClosablePanel,
  type TabsClosableTab,
  Tooltip,
} from '@corral/react/design-kit';
import { Bug, Plus, Terminal } from '@corral/react/icons';
import type { ReactNode, Ref } from 'react';
import { useTranslations } from 'use-intl';
import { type DockKey, type DockState, type DockTab, dockKey } from '../panel/dock.ts';
import type { CreationBlock } from '../terminals/creation.ts';

export const DOCK_ID_PREFIX = 'session-dock';

/** What the dock's "+" lists: the terminal row (usable or not, with its shells) and the debugger. */
export interface DockPlus {
  /** Null when the conversation has no Paddock in server mode: no terminal row. */
  readonly terminal: {
    /** A live terminal's tab is opened or selected; otherwise a new one is made. */
    readonly live: boolean;
    /** Why a new terminal cannot be made now; the row stays, unusable, with this line. */
    readonly blocked: CreationBlock | null;
    /** The shells to choose from when making one; two or more open a submenu. */
    readonly shells: readonly { id: string; label: string }[];
  } | null;
  readonly debug: boolean;
}

/** The sentence of a blocked creation, as the terminal screen says it. */
export function useCreationReason() {
  const t = useTranslations('Terminals');
  return (reason: CreationBlock) =>
    t(
      (
        {
          loading: 'loading',
          listFailed: 'actionFailed',
          noCopy: 'unavailable',
          createPending: 'createPending',
          createHeld: 'createHeld',
          runActive: 'runActive',
          unavailable: 'unavailable',
        } as const
      )[reason],
    );
}

const STATE_COLOR: Record<TerminalView['state'], string> = {
  starting: 'var(--emphasis)',
  running: 'var(--emphasis)',
  stopping: 'var(--emphasis)',
  exited: 'var(--muted-foreground)',
  failed: 'var(--destructive)',
  uncertain: 'var(--warning)',
};

export function SessionDock({
  sessionId,
  dock,
  strip,
  terminals,
  plus,
  body,
  onSelect,
  onClose,
  onTerminal,
  onDebug,
  renderTab,
}: {
  sessionId: string;
  dock: DockState;
  strip: Ref<TabsClosableHandle>;
  /** The conversation's terminals as its list says them, oldest first. */
  terminals: readonly TerminalView[];
  plus: DockPlus;
  /** With no tab: the reason line and at most one action. */
  body: ReactNode;
  onSelect: (key: DockKey) => void;
  onClose: (key: DockKey) => void;
  /** "+" → 터미널: the shell chosen in the submenu, or none. */
  onTerminal: (shellId?: string) => void;
  onDebug: () => void;
  renderTab: (tab: DockTab) => ReactNode;
}) {
  const t = useTranslations('SessionPanel');
  const tt = useTranslations('Terminals');
  const td = useTranslations('Docking');
  const reason = useCreationReason();
  const nameOf = (tab: DockTab) => {
    if (tab.kind === 'debug') return t('debugTab');
    const index = terminals.findIndex((item) => item.terminalId === tab.terminalId);
    return t('terminalTab', { number: index < 0 ? terminals.length + 1 : index + 1 });
  };
  const tabs: TabsClosableTab[] = dock.tabs.map((tab) => {
    const view =
      tab.kind === 'terminal'
        ? terminals.find((item) => item.terminalId === tab.terminalId)
        : undefined;
    const label = nameOf(tab);
    const stateText = view
      ? view.state === 'exited' && view.stopped
        ? tt('stopped')
        : tt(`state.${view.state}`)
      : undefined;
    return {
      id: dockKey(tab),
      label,
      ...(tab.kind === 'terminal' ? { shortLabel: label.replace(/^\D+/, '') || label } : {}),
      icon: tab.kind === 'debug' ? Bug : Terminal,
      ...(view
        ? {
            mark: <LiveDot color={STATE_COLOR[view.state]} live={view.state === 'running'} />,
            description: stateText,
          }
        : {}),
    };
  });
  const terminalRow = plus.terminal;
  const plusMenu =
    terminalRow || plus.debug ? (
      <Menu>
        <Tooltip content={t('add')}>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-compact" aria-label={t('add')} />}
          >
            <Plus />
          </MenuTrigger>
        </Tooltip>
        <MenuPopup align="start" className="w-[260px]">
          {terminalRow ? (
            !terminalRow.live && !terminalRow.blocked && terminalRow.shells.length > 1 ? (
              <MenuSub>
                <MenuSubTrigger icon={Terminal}>{td('terminal')}</MenuSubTrigger>
                <MenuSubPopup aria-label={tt('chooseShell')}>
                  {terminalRow.shells.map((shell) => (
                    <MenuItem key={shell.id} onClick={() => onTerminal(shell.id)}>
                      {shell.label}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ) : (
              <MenuItem
                icon={Terminal}
                disabled={!terminalRow.live && terminalRow.blocked !== null}
                description={
                  !terminalRow.live && terminalRow.blocked ? reason(terminalRow.blocked) : undefined
                }
                onClick={() => onTerminal()}
              >
                {td('terminal')}
              </MenuItem>
            )
          ) : null}
          {plus.debug ? (
            <MenuItem icon={Bug} onClick={onDebug}>
              {t('debugTab')}
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    ) : null;
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <div data-dock-head="" className="flex h-9 shrink-0 items-center border-b border-line px-2">
        {tabs.length ? (
          <TabsClosable
            ref={strip}
            className="min-w-0 flex-1"
            aria-label={t('dockTabs')}
            idPrefix={DOCK_ID_PREFIX}
            tabs={tabs}
            selectedId={dock.selected}
            onSelect={(id) => onSelect(id as DockKey)}
            onClose={(id) => onClose(id as DockKey)}
            closeLabel={(tab) => t('close', { name: tab.label })}
            trailing={plusMenu}
          />
        ) : (
          plusMenu
        )}
      </div>
      {tabs.length ? (
        dock.tabs.map((tab) => {
          const key = dockKey(tab);
          return (
            <TabsClosablePanel
              key={`${sessionId}:${key}`}
              idPrefix={DOCK_ID_PREFIX}
              tabId={key}
              selected={key === dock.selected}
              className="flex min-h-0 flex-1 flex-col"
            >
              {renderTab(tab)}
            </TabsClosablePanel>
          );
        })
      ) : (
        <div
          data-dock-reason=""
          className="flex min-h-0 flex-1 flex-col items-start gap-2 overflow-auto px-3 py-2 text-caption text-muted-foreground"
        >
          {body}
        </div>
      )}
    </div>
  );
}
