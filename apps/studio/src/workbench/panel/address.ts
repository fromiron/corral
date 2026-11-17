// What the session address says about the panel (features/session-panel.md "주소와 기억").
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import type { PanelResult, PanelState } from './model.ts';
import {
  PANEL_TAB_OF,
  type PanelFronts,
  type PanelTab,
  type PanelTarget,
  type TabKey,
  tabKey,
  tabPanel,
} from './tabs.ts';

/**
 * The three cases an address is read as. `neither` covers a bare address and one carrying only
 * other parameters; `respond` counts as neither even with `panel`. `bringForward` is set when
 * the address asks for the conversation (`respond`, `advice`, `message` without `panel`).
 */
export type AddressCase =
  | { readonly kind: 'panel'; readonly target: PanelTarget; readonly bringForward: boolean }
  | { readonly kind: 'compose'; readonly bringForward: boolean }
  | { readonly kind: 'neither'; readonly bringForward: boolean };

/** The frame's part of an address: always exactly one of `panel` and `compose`. */
export type PanelAddress =
  | { readonly panel: SessionPanel; readonly run?: string; readonly terminal?: string }
  | { readonly compose: true };

/** The address parameters the frame reads; every other one (`settings`) is left alone. */
export const FRAME_PARAMS = [
  'panel',
  'run',
  'view',
  'result',
  'execution',
  'artifact',
  'atSeq',
  'terminal',
  'review',
  'scope',
  'runId',
  'file',
  'message',
  'respond',
  'advice',
  'compose',
] as const;

export function readAddress(search: SessionSearch): AddressCase {
  // A message without `panel` is going to that message; with `panel` the address is a panel
  // address and the conversation is only placed at the message.
  const bringForward = Boolean(
    search.respond || search.advice || (search.message && !search.panel),
  );
  // A request to respond is answered in the conversation and never opens a tab.
  if (search.respond) return { kind: 'neither', bringForward };
  if (search.panel) {
    const target: PanelTarget =
      search.panel === 'run' && search.run
        ? { panel: 'run', run: search.run }
        : search.panel === 'terminal' && search.terminal
          ? { panel: 'terminal', terminal: search.terminal }
          : { panel: search.panel };
    return { kind: 'panel', target, bringForward };
  }
  if (search.compose) return { kind: 'compose', bringForward };
  return { kind: 'neither', bringForward };
}

/**
 * The frame's part of the address for a state: the selected tab's `panel` (and `run`) while the
 * panel is open with a tab, otherwise `compose`. `fronts` holds the window or view in front
 * inside the 파일 and 변경 tabs; the selected tab's own one is written when it belongs to it.
 */
export function panelAddress(state: PanelState, fronts?: PanelFronts): PanelAddress {
  const tab = selectedTab(state);
  if (state.presentation === 'closed' || !tab) return { compose: true };
  if (tab.kind === 'run') return { panel: 'run', run: tab.runId };
  if (tab.kind === 'terminal') return { panel: 'terminal', terminal: tab.terminalId };
  const front: SessionPanel | undefined =
    tab.kind === 'files' ? fronts?.files : tab.kind === 'changes' ? fronts?.changes : undefined;
  return { panel: front && PANEL_TAB_OF[front] === tab.kind ? front : tabPanel(tab) };
}

/** What a tab writes into the address beside `panel`; respond, advice and message are not. */
export const TAB_PARAMS = [
  'view',
  'result',
  'execution',
  'artifact',
  'atSeq',
  'terminal',
  'review',
  'scope',
  'runId',
  'file',
] as const satisfies readonly (keyof SessionSearch)[];

/**
 * The whole session search to write for a reduced event, as a fresh search (not a patch).
 * `current` is the search in the address now (for `enter`, `follow` and `history` the one that
 * arrived). `own` is the selected tab's own state (view, result, execution, review, file …): the
 * caller passes it for a strip choice and for an opening way that points inside a tab.
 * - Restoring on entry drops the other frame parameters; a parameter the frame does not read
 *   (`settings`) is kept.
 * - `respond` and `advice` are consumed; `message` stays (on entry it is gone to after restoring).
 * - Without `own`, the tab's state in `current` is kept only while the same tab stays selected,
 *   so a clean-up that swaps the run drops the old run's view, result, execution, artifact and
 *   position.
 * - The result has exactly one of `panel` and `compose`, and nothing beside `compose` that would
 *   make `validateSessionSearch` drop it. The legacy `tab` parameter is dropped.
 */
export function nextSearch(
  current: SessionSearch,
  result: PanelResult,
  own?: SessionSearch,
): SessionSearch {
  const { tab: _legacy, ...unread } = withoutFrameParams(current as Record<string, unknown>);
  const rest = unread as SessionSearch;
  // A message to go to stays, on entry too: the conversation is placed at it after restoring.
  const message = current.message ? { message: current.message } : {};
  const address = result.address;
  if ('compose' in address) return { ...rest, ...message, compose: true };
  const source = own ?? (addressedTab(current) === result.state.selected ? current : {});
  const inner: SessionSearch = {};
  for (const key of TAB_PARAMS)
    if (source[key] !== undefined) Object.assign(inner, { [key]: source[key] });
  return { ...rest, ...inner, ...message, ...address };
}

// The tab an address names, when it names one exactly.
function addressedTab(search: SessionSearch): TabKey | null {
  if (!search.panel) return null;
  const kind = PANEL_TAB_OF[search.panel];
  if (kind === null) return null;
  if (kind === 'run') return search.run ? `run:${search.run}` : null;
  if (kind === 'terminal') return search.terminal ? `terminal:${search.terminal}` : null;
  return kind;
}

/** An address without the frame's parameters, keeping the ones the frame does not read. */
export function withoutFrameParams(search: Record<string, unknown>): Record<string, unknown> {
  const frame: ReadonlySet<string> = new Set(FRAME_PARAMS);
  return Object.fromEntries(Object.entries(search).filter(([key]) => !frame.has(key)));
}

function selectedTab(state: PanelState): PanelTab | undefined {
  return state.tabs.find((tab) => tabKey(tab) === state.selected);
}
