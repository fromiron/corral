// The bottom dock's screen (features/session-panel.md 하단 도크): a head with its strip of
// terminal and debug tabs and the "+" after the last one, then the selected tab. With no tab
// there is no head and the body lists what "+" would (or, without a Paddock or a terminal list,
// says why in one line). What the dock holds is the page's state (panel/dock.ts).
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
import { type ReactNode, type Ref, useId } from 'react';
import { useTranslations } from 'use-intl';
import { type DockKey, type DockState, type DockTab, dockKey } from '../panel/dock.ts';
import type { CreationBlock } from '../terminals/creation.ts';

export const DOCK_ID_PREFIX = 'session-dock';
/** The panel's strip and the dock's share it: terminal tabs cross between them by drag. */
export const TERMINAL_MOVE_GROUP = 'session-terminals';

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

/**
 * The "+" list's 터미널 row, the same in the panel's list and the dock's: a submenu of shells when
 * a new terminal is made and there are two or more; an unavailable row with its reason when none
 * can be made and none is live. It is drawn as the list's own row, not through a component of
 * its own, so the list numbers it in its place.
 */
export function useTerminalPlusRow() {
  const td = useTranslations('Docking');
  const tt = useTranslations('Terminals');
  const reason = useCreationReason();
  return (row: NonNullable<DockPlus['terminal']>, onTerminal: (shellId?: string) => void) => {
    if (!row.live && !row.blocked && row.shells.length > 1)
      return (
        <MenuSub key="terminal">
          <MenuSubTrigger icon={Terminal}>{td('terminal')}</MenuSubTrigger>
          <MenuSubPopup aria-label={tt('chooseShell')}>
            {row.shells.map((shell) => (
              <MenuItem key={shell.id} onClick={() => onTerminal(shell.id)}>
                {shell.label}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      );
    const blocked = !row.live ? row.blocked : null;
    return (
      <MenuItem
        key="terminal"
        icon={Terminal}
        disabled={blocked !== null}
        description={blocked ? reason(blocked) : undefined}
        onClick={() => onTerminal()}
      >
        {td('terminal')}
      </MenuItem>
    );
  };
}

/**
 * The 터미널 row of the body's list (a panel or a dock with no tab): the same choices as "+"'s
 * row, as the list's buttons. Unavailable, it stays focusable and says why on a second line.
 */
export function TerminalListRow({
  row,
  onTerminal,
}: {
  row: NonNullable<DockPlus['terminal']>;
  onTerminal: (shellId?: string) => void;
}) {
  const td = useTranslations('Docking');
  const tt = useTranslations('Terminals');
  const reason = useCreationReason();
  const reasonId = useId();
  const content = (
    <>
      <Terminal aria-hidden="true" />
      {td('terminal')}
    </>
  );
  if (!row.live && !row.blocked && row.shells.length > 1)
    return (
      <Menu>
        <MenuTrigger render={<Button variant="ghost" className="w-full justify-start gap-2" />}>
          {content}
        </MenuTrigger>
        <MenuPopup align="start" aria-label={tt('chooseShell')}>
          {row.shells.map((shell) => (
            <MenuItem key={shell.id} onClick={() => onTerminal(shell.id)}>
              {shell.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    );
  const blocked = !row.live ? row.blocked : null;
  if (blocked)
    return (
      <Button
        variant="ghost"
        aria-disabled="true"
        aria-describedby={reasonId}
        className="h-auto w-full flex-col items-start gap-0.5 py-1.5"
      >
        <span className="flex items-center gap-2 text-muted-foreground">{content}</span>
        <span
          id={reasonId}
          className="text-caption text-muted-foreground whitespace-normal text-left"
        >
          {reason(blocked)}
        </span>
      </Button>
    );
  return (
    <Button variant="ghost" className="w-full justify-start gap-2" onClick={() => onTerminal()}>
      {content}
    </Button>
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

/**
 * What a terminal's tab says of its state in either strip: the mark in the icon's place and the
 * state in words as the tab's description (features/session-panel.md 터미널 탭).
 */
export function useTerminalTabState(terminals: readonly TerminalView[]) {
  const tt = useTranslations('Terminals');
  return (terminalId: string): Pick<TabsClosableTab, 'mark' | 'description'> => {
    const view = terminals.find((item) => item.terminalId === terminalId);
    if (!view) return {};
    return {
      mark: (
        <span data-terminal-state={view.state} className="inline-flex">
          <LiveDot color={STATE_COLOR[view.state]} live={view.state === 'running'} />
        </span>
      ),
      description:
        view.state === 'exited' && view.stopped ? tt('stopped') : tt(`state.${view.state}`),
    };
  };
}

export function SessionDock({
  sessionId,
  dock,
  strip,
  terminals,
  plus,
  line,
  onSelect,
  onClose,
  onReorder,
  onMoveOut,
  onMoveIn,
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
  /**
   * With no tab, the one line that stands in place of the list (no Paddock, an unread terminal
   * list) with its button; null shows the list.
   */
  line: ReactNode;
  onSelect: (key: DockKey) => void;
  onClose: (key: DockKey) => void;
  /** A tab dragged, or moved by Mod+Shift+←/→, to `toIndex` in the strip. */
  onReorder: (key: DockKey, toIndex: number) => void;
  /** A terminal's tab dragged out into the panel: it leaves as a close, ending nothing. */
  onMoveOut: (key: DockKey) => void;
  /** A terminal's tab dragged in from the panel, let go before the tab at `index`. */
  onMoveIn: (terminalId: string, index: number) => void;
  /** "+" → 터미널: the shell chosen in the submenu, or none. */
  onTerminal: (shellId?: string) => void;
  onDebug: () => void;
  renderTab: (tab: DockTab) => ReactNode;
}) {
  const t = useTranslations('SessionPanel');
  const stateOf = useTerminalTabState(terminals);
  const nameOf = (tab: DockTab) => {
    if (tab.kind === 'debug') return t('debugTab');
    const index = terminals.findIndex((item) => item.terminalId === tab.terminalId);
    return t('terminalTab', { number: index < 0 ? terminals.length + 1 : index + 1 });
  };
  const tabs: TabsClosableTab[] = dock.tabs.map((tab) => {
    const label = nameOf(tab);
    return {
      id: dockKey(tab),
      label,
      ...(tab.kind === 'terminal' ? { shortLabel: label.replace(/^\D+/, '') || label } : {}),
      icon: tab.kind === 'debug' ? Bug : Terminal,
      ...(tab.kind === 'terminal' ? { ...stateOf(tab.terminalId), movable: true } : {}),
    };
  });
  const terminalRow = plus.terminal;
  const terminalPlusRow = useTerminalPlusRow();
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
          {terminalRow ? terminalPlusRow(terminalRow, onTerminal) : null}
          {plus.debug ? (
            <MenuItem icon={Bug} onClick={onDebug}>
              {t('debugTab')}
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    ) : null;
  if (!tabs.length)
    return (
      // As the panel with no tab: no head and no "+", the list in the body.
      <div
        data-dock-body=""
        className="flex h-full min-h-0 flex-col overflow-auto border-t border-border px-3 py-2"
      >
        {line ? (
          <div
            data-dock-line=""
            className="flex flex-col items-start gap-2 text-caption text-muted-foreground"
          >
            {line}
          </div>
        ) : (
          <ul data-dock-list="" className="flex w-[min(320px,100%)] flex-col gap-1">
            {terminalRow ? (
              <li>
                <TerminalListRow row={terminalRow} onTerminal={onTerminal} />
              </li>
            ) : null}
            {plus.debug ? (
              <li>
                <Button variant="ghost" className="w-full justify-start gap-2" onClick={onDebug}>
                  <Bug aria-hidden="true" />
                  {t('debugTab')}
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <div data-dock-head="" className="flex h-9 shrink-0 items-center border-b border-line px-2">
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
          onReorder={(id, toIndex) => onReorder(id as DockKey, toIndex)}
          announceMove={(tab, n, count) => t('tabPosition', { label: tab.label, n, count })}
          moveGroup={TERMINAL_MOVE_GROUP}
          onMoveOut={(id) => onMoveOut(id as DockKey)}
          onMoveIn={(id, index) => {
            if (id.startsWith('terminal:')) onMoveIn(id.slice('terminal:'.length), index);
          }}
        />
      </div>
      {dock.tabs.map((tab) => {
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
      })}
    </div>
  );
}
