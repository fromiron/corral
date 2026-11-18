// Test fixtures for the panel model's tests only; no product code imports this file.
import type { RunStatus } from '@corral/contracts';
import type { SessionSearch } from '../panels/routes.ts';
import type { PanelMemory } from './memory.ts';
import {
  EMPTY_PANEL,
  type EntryVia,
  type OpenTab,
  type PanelEvent,
  type PanelResult,
  type PanelState,
  reducePanel,
  tabOf,
} from './model.ts';
import type { PanelContext, PanelTab, PanelTarget } from './tabs.ts';

export const files: PanelTab = { kind: 'files' };
export const changes: PanelTab = { kind: 'changes' };
export const artifacts: PanelTab = { kind: 'artifacts' };
export const run = (runId: string): PanelTab => ({ kind: 'run', runId });

/** Room, a folder and two known runs unless a test says otherwise. */
export const ctx = (over: Partial<PanelContext> = {}): PanelContext => ({
  room: true,
  folder: true,
  runIds: ['run_1', 'run_2'],
  ...over,
});
export const narrow = (over: Partial<PanelContext> = {}) => ctx({ room: false, ...over });
/** The run list not answered yet. */
export const unlisted = (over: Partial<PanelContext> = {}) => ctx({ runIds: null, ...over });

/** A state with these tabs open, each already seen, numbered from 1. */
export function panel(
  over: Partial<Omit<PanelState, 'tabs'>> & { tabs?: readonly PanelTab[] } = {},
): PanelState {
  const { tabs = [], ...rest } = over;
  const open: OpenTab[] = tabs.map((tab, i) => ({ ...tab, instance: i + 1, seen: true }));
  return { ...EMPTY_PANEL, nextInstance: open.length + 1, ...rest, tabs: open };
}

/** The tabs' identities, in order. */
export const ids = (state: PanelState): PanelTab[] => state.tabs.map(tabOf);
/** What a person sees: the tabs, the selection and the presentation. */
export const shape = (state: PanelState) => ({
  tabs: ids(state),
  selected: state.selected,
  presentation: state.presentation,
});

export const steps = (state: PanelState, events: readonly PanelEvent[], context = ctx()) =>
  events.reduce<PanelResult>((result, event) => reducePanel(result.state, event, context), {
    state,
    address: { compose: true },
    history: null,
    bringForward: false,
    dropHeadConfirmation: false,
  });

export const way = (target: PanelTarget): PanelEvent => ({ type: 'open', target, from: 'way' });
export const runLink = (runId: string) => way({ panel: 'run', run: runId });
export const enter = (
  search: SessionSearch,
  memory: PanelMemory | null,
  via: EntryVia = 'link',
): PanelEvent => ({ type: 'enter', search, memory, via });
export const context: PanelEvent = { type: 'context' };

export const statuses =
  (map: Record<string, RunStatus>) =>
  (runId: string): RunStatus | undefined =>
    map[runId];
