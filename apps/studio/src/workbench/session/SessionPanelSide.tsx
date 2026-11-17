import type { TerminalView } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { type Presence, projectionPresence } from '@corral/react';
import {
  Button,
  fontWeights,
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
import {
  FileDiff,
  FileText,
  Folder,
  History,
  Maximize2,
  Minimize2,
  Plus,
  Terminal,
} from '@corral/react/icons';
import { type ReactNode, type Ref, useCallback, useSyncExternalStore } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { PresenceMark } from '../PresenceMark.tsx';
import { maximizeAvailable, type OpenTab, type PanelState } from '../panel/model.ts';
import {
  type PanelContext,
  type PanelTab,
  type PlusItem,
  plusItems,
  type TabKey,
  tabKey,
} from '../panel/tabs.ts';
import { listedRunPresence } from '../sessionList.ts';
import {
  type DockPlus,
  TERMINAL_MOVE_GROUP,
  TerminalListRow,
  TerminalPlusItem,
  useTerminalTabState,
} from './SessionDock.tsx';

// The panel beside the conversation (features/session-panel.md): its head — the strip of tabs,
// "+" after the last one, maximize at the far right — and one panel per open tab. With no tab
// the body is the "+" list itself, under one title line.

export const PANEL_ID_PREFIX = 'session-panel';

type Kind = PanelTab['kind'];
const ICONS = {
  files: Folder,
  terminal: Terminal,
  changes: FileDiff,
  run: History,
  artifacts: FileText,
} as const;
const PLUS_ICONS: Record<PlusItem, (typeof ICONS)[Kind]> = {
  files: Folder,
  terminal: Terminal,
  changes: FileDiff,
  'run-history': History,
  artifacts: FileText,
};

/**
 * A tab's name: 실행 #n once the run's number is known, 실행 until then; 터미널 n by the order the
 * conversation's terminals were made in.
 */
export function usePanelTabName(
  runIds: readonly string[] | null,
  terminalIds?: readonly string[] | null,
) {
  const t = useTranslations('Docking');
  const tw = useTranslations('Workbench');
  const tp = useTranslations('SessionPanel');
  return (tab: PanelTab): { label: string; shortLabel?: string } => {
    if (tab.kind === 'terminal') {
      const index = terminalIds?.indexOf(tab.terminalId) ?? -1;
      if (index < 0) return { label: t('terminal') };
      return { label: tp('terminalTab', { number: index + 1 }), shortLabel: String(index + 1) };
    }
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

/** One run of the "+" list's run history: its state's mark, its number and its request. */
interface HistoryRun {
  runId: string;
  /** The run's state (`useRunPresences`); null if nothing says it yet. */
  presence: Presence | null;
  /** `#n · request`, or `Run #n` without a request. */
  name: string;
}

/**
 * The conversation's runs as the run history lists them, newest first: each row names the run by
 * its number and request (`#n · request`, or `Run #n` without one), its mark showing the state,
 * which the row's name says in words. The rows are the menu's own children, so the kit numbers
 * them.
 */
function useRunHistoryRows(runs: readonly HistoryRun[], onOpenRun: (runId: string) => void) {
  const presenceText = useTranslations('Presence');
  const format = useFormatter();
  return [...runs].reverse().map((run) => {
    const { presence } = run;
    return (
      <MenuItem
        key={run.runId}
        label={
          presence
            ? format.list([run.name, presenceText(presence.labelKey)], { type: 'unit' })
            : run.name
        }
        onClick={() => onOpenRun(run.runId)}
      >
        <span
          data-run-history-row=""
          className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2"
        >
          <PresenceMark presence={presence} />
          <span className="truncate">{run.name}</span>
        </span>
      </MenuItem>
    );
  });
}

/**
 * Each run's state, one per screen (docs/specs/features/presence.md): while a view follows the
 * run (its record, the conversation), the state its live store says, which the record's head and
 * the conversation say too; otherwise the run list's, which can lag the run. Nothing before the
 * list answers.
 */
function useRunPresences(runIds: readonly string[] | null, runs: readonly RunSummary[]) {
  const { liveRun, watchRuns } = useServices();
  const key = runIds?.join(',') ?? '';
  const live = useCallback(
    (runId: string): Presence | null => {
      const state = liveRun?.(runId)?.getState();
      return state?.projection?.runId === runId
        ? projectionPresence(state.projection, state.events)
        : null;
    },
    [liveRun],
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      let stops: (() => void)[] = [];
      // The stores followed now; again whenever a run starts or stops being followed.
      const follow = () => {
        for (const stop of stops) stop();
        stops = (key ? key.split(',') : []).flatMap((runId) => {
          const store = liveRun?.(runId);
          return store ? [store.subscribe(notify)] : [];
        });
      };
      follow();
      const unwatch = watchRuns?.(() => {
        follow();
        notify();
      });
      return () => {
        unwatch?.();
        for (const stop of stops) stop();
      };
    },
    [key, liveRun, watchRuns],
  );
  const snapshot = useCallback(
    () =>
      (key ? key.split(',') : [])
        .map((runId) => {
          const presence = live(runId);
          return presence ? [presence.kind, presence.need, presence.detail].join('/') : '';
        })
        .join('|'),
    [key, live],
  );
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return (runId: string): Presence | null => {
    if (runIds === null) return null;
    const summary = runs.find((run) => run.runId === runId);
    return live(runId) ?? (summary ? listedRunPresence(summary) : null);
  };
}

/** The run history's rows, numbered by the run list's order, named as the tabs are. */
function useHistoryRuns(
  ctx: PanelContext,
  presenceOf: (runId: string) => Presence | null,
  names: Readonly<Record<string, string | null | undefined>>,
): HistoryRun[] {
  const tw = useTranslations('Workbench');
  const tr = useTranslations('RunPage');
  return (ctx.runIds ?? []).map((runId, index) => {
    const number = index + 1;
    const name = names[runId];
    return {
      runId,
      presence: presenceOf(runId),
      name: name ? tr('runName', { number, name }) : tw('runNumber', { number }),
    };
  });
}

/** The cap on the run history's height: a long history scrolls inside its list. */
const HISTORY_LIST = 'max-h-[min(320px,var(--available-height))]';

export function SessionPanelSide({
  sessionId,
  state,
  ctx,
  strip,
  runs,
  runNames,
  onSelect,
  onClose,
  onReorder,
  onMoveOut,
  onMoveIn,
  onPlus,
  terminalRow,
  terminals,
  onTerminal,
  onOpenRun,
  onMaximize,
  renderTab,
}: {
  sessionId: string;
  state: PanelState;
  ctx: PanelContext;
  /** The session's runs as its run list says them: their states. */
  runs: readonly RunSummary[];
  /** Each run's request summary, or its team's name when nothing was requested. */
  runNames: Readonly<Record<string, string | null | undefined>>;
  strip: Ref<TabsClosableHandle>;
  onSelect: (key: TabKey) => void;
  onClose: (key: TabKey) => void;
  /** A tab dragged, or moved by Mod+Shift+←/→, to `toIndex` in the strip. */
  onReorder: (key: TabKey, toIndex: number) => void;
  /** A terminal's tab dragged out into the bottom dock: it leaves as a close, ending nothing. */
  onMoveOut: (key: TabKey) => void;
  /** A terminal's tab dragged in from the bottom dock, let go before the tab at `index`. */
  onMoveIn: (terminalId: string, index: number) => void;
  onPlus: (item: Exclude<PlusItem, 'terminal'>) => void;
  /** The "+" list's 터미널 row: null when the conversation has no Paddock in server mode. */
  terminalRow: DockPlus['terminal'];
  /** The conversation's terminals as its list says them: a terminal tab says its state. */
  terminals: readonly TerminalView[];
  /** "+" → 터미널: the shell chosen in its submenu, or none. */
  onTerminal: (shellId?: string) => void;
  /** A run chosen in the run history: its tab opens or is selected. */
  onOpenRun: (runId: string) => void;
  onMaximize: () => void;
  renderTab: (tab: OpenTab) => ReactNode;
}) {
  const t = useTranslations('SessionPanel');
  const tp = useTranslations('Presence');
  const name = usePanelTabName(ctx.runIds, ctx.terminalIds);
  const plusLabel = usePlusLabel();
  const items = plusItems(ctx);
  const presenceOf = useRunPresences(ctx.runIds, runs);
  const terminalState = useTerminalTabState(terminals);
  const history = useHistoryRuns(ctx, presenceOf, runNames);
  const historyRows = useRunHistoryRows(history, onOpenRun);
  // With one run, the run history opens it; with more, it lists them.
  const listed = history.length > 1;
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
              const content = (
                <>
                  <Icon aria-hidden="true" />
                  {plusLabel(item)}
                </>
              );
              return (
                <li key={item}>
                  {item === 'terminal' ? (
                    terminalRow ? (
                      <TerminalListRow row={terminalRow} onTerminal={onTerminal} />
                    ) : null
                  ) : item === 'run-history' && listed ? (
                    // The same list as "+"'s, in place on its row.
                    <Menu>
                      <MenuTrigger
                        render={<Button variant="ghost" className="w-full justify-start gap-2" />}
                      >
                        {content}
                      </MenuTrigger>
                      <MenuPopup
                        align="start"
                        aria-label={plusLabel(item)}
                        className={`w-[min(320px,var(--available-width))] ${HISTORY_LIST}`}
                      >
                        {historyRows}
                      </MenuPopup>
                    </Menu>
                  ) : (
                    <Button
                      variant="ghost"
                      className="w-full justify-start gap-2"
                      onClick={() => onPlus(item)}
                    >
                      {content}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  const tabs: TabsClosableTab[] = state.tabs.map((tab) => {
    // A run tab carries its run's state in the icon's place, as the run history says it, except
    // once the run completed; before the run list answers it keeps the run icon.
    const presence = tab.kind === 'run' ? presenceOf(tab.runId) : null;
    const marked = presence && presence.kind !== 'succeeded' ? presence : null;
    return {
      id: tabKey(tab),
      icon: ICONS[tab.kind],
      ...name(tab),
      ...(marked
        ? { mark: <PresenceMark presence={marked} />, description: tp(marked.labelKey) }
        : {}),
      ...(tab.kind === 'terminal' ? { ...terminalState(tab.terminalId), movable: true } : {}),
    };
  });
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
          onReorder={(id, toIndex) => onReorder(id as TabKey, toIndex)}
          announceMove={(tab, n, count) => t('tabPosition', { label: tab.label, n, count })}
          moveGroup={TERMINAL_MOVE_GROUP}
          onMoveOut={(id) => onMoveOut(id as TabKey)}
          onMoveIn={(id, index) => {
            if (id.startsWith('terminal:')) onMoveIn(id.slice('terminal:'.length), index);
          }}
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
                    if (item === 'terminal')
                      return terminalRow ? (
                        <TerminalPlusItem key={item} row={terminalRow} onTerminal={onTerminal} />
                      ) : null;
                    return item === 'run-history' && listed ? (
                      <MenuSub key={item}>
                        <MenuSubTrigger icon={Icon}>{plusLabel(item)}</MenuSubTrigger>
                        <MenuSubPopup
                          aria-label={plusLabel(item)}
                          className={`w-[min(320px,var(--available-width))] ${HISTORY_LIST}`}
                        >
                          {historyRows}
                        </MenuSubPopup>
                      </MenuSub>
                    ) : (
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
