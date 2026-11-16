// The session panel's tabs (features/session-panel.md "탭", "\"+\" 목록"): what each kind is,
// which `panel` address value means which tab, and what can be opened now. Plain data only.
import { panelRunId } from '../panelRun.ts';
import type { SessionPanel } from '../panels/registry.ts';

export type TabKind = 'files' | 'changes' | 'run' | 'artifacts';

/** A tab of the panel. 파일, 변경 and 결과 are one per conversation; 실행 is one per run. */
export type PanelTab =
  | { readonly kind: 'files' | 'changes' | 'artifacts' }
  | { readonly kind: 'run'; readonly runId: string };

/** A tab's identity in the strip: two tabs with the same key are the same tab. */
export type TabKey = 'files' | 'changes' | 'artifacts' | `run:${string}`;

/** Every `panel` value names the tab that carries it ("탭" table). */
export const PANEL_TAB_OF: Readonly<Record<SessionPanel, TabKind>> = {
  files: 'files',
  terminal: 'files',
  tools: 'files',
  debug: 'files',
  changes: 'changes',
  git: 'changes',
  checks: 'changes',
  problems: 'changes',
  run: 'run',
  artifacts: 'artifacts',
};

/** What an opening way or an address asks for: a `panel` value and, for 실행, a run. */
export interface PanelTarget {
  readonly panel: SessionPanel;
  readonly run?: string | undefined;
}

/** What the conversation can open now, passed in with every event. */
export interface PanelContext {
  /** The work area holds the conversation's 560px and the panel's 360px. */
  readonly room: boolean;
  /** A project folder is connected to the conversation. */
  readonly folder: boolean;
  /**
   * The conversation's runs, oldest first (the last one is the newest), from a listing asked
   * after this entry; null until that listing has answered. Null is "nothing to list yet": it
   * never closes anything and never decides that the conversation has no run.
   */
  readonly runIds: readonly string[] | null;
  /**
   * The `panel` value of the window or view now in front inside the 파일 and 변경 tabs
   * (`terminal`, `git`, …), so the address written for that tab names it.
   */
  readonly front?: PanelFronts | undefined;
}

/** The window or view in front inside each tab that has them. */
export interface PanelFronts {
  readonly files?: SessionPanel | undefined;
  readonly changes?: SessionPanel | undefined;
}

/** The "+" list's items, in their order. */
export type PlusItem = 'files' | 'changes' | 'run-history' | 'artifacts';

export function tabKey(tab: PanelTab): TabKey {
  return tab.kind === 'run' ? `run:${tab.runId}` : tab.kind;
}

/** The `panel` value a tab writes when nothing inside it is in front. */
export function tabPanel(tab: PanelTab): SessionPanel {
  return tab.kind;
}

/**
 * The tab a target opens. `panel=run` without `run` is the newest run's tab; with no run, or
 * before the run list is known, there is no tab (null). A named run is kept even when it is not
 * listed yet (a run just started): the run list's answer settles it (`panelRunId`).
 */
export function targetTab(target: PanelTarget, runIds: readonly string[] | null): PanelTab | null {
  const kind = PANEL_TAB_OF[target.panel];
  if (kind !== 'run') return { kind };
  const runId = panelRunId(
    (runIds ?? []).map((id) => ({ runId: id })),
    target.run,
    false,
  );
  return runId ? { kind: 'run', runId } : null;
}

/** The "+" list: only what can be opened now, in order; run items once the run list is known. */
export function plusItems(ctx: Pick<PanelContext, 'folder' | 'runIds'>): PlusItem[] {
  const runs = (ctx.runIds?.length ?? 0) > 0;
  return [
    ...(ctx.folder ? (['files', 'changes'] as const) : []),
    ...(runs ? (['run-history', 'artifacts'] as const) : []),
  ];
}

/** What choosing a "+" item opens; 실행 기록 is the newest run's tab. */
export function plusTarget(item: PlusItem, ctx: Pick<PanelContext, 'runIds'>): PanelTarget {
  if (item !== 'run-history') return { panel: item };
  const newest = ctx.runIds?.at(-1);
  return newest ? { panel: 'run', run: newest } : { panel: 'run' };
}
