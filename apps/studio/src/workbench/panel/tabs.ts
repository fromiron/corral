// The session panel's tabs (features/session-panel.md "탭", "\"+\" 목록"): what each kind is,
// which `panel` address value means which tab, and what can be opened now. Plain data only.
import { panelRunId } from '../panelRun.ts';
import type { SessionPanel } from '../panels/registry.ts';

export type TabKind =
  | 'files'
  | 'document'
  | 'graph'
  | 'terminal'
  | 'changes'
  | 'run'
  | 'artifacts'
  | 'tools';

/** Where a document's file is: the project's source folder, or the conversation's Paddock. */
export type DocumentSource = 'original' | 'copy';

/** The Paddock a copy's document was read from: its binding and generation. */
export interface CopyIdentity {
  readonly bindingId: string;
  readonly generation: number;
}

/** The inner tab in front inside 작업: its tasks or its previews. */
export type ToolsView = 'tasks' | 'preview';

/**
 * A tab of the panel. 파일, 변경, 결과 and 작업 are one per conversation; 문서 is one per file (its
 * source and relative path); 팀 그래프 is one per team; 실행 is one per run; 터미널 is one per
 * terminal, and a terminal's tab is in the panel or in the bottom dock, never both.
 */
export type PanelTab =
  | { readonly kind: 'files' | 'changes' | 'artifacts' }
  | {
      readonly kind: 'document';
      readonly source: DocumentSource;
      readonly path: string;
      /** A copy's document once its Paddock is known; restore drops it when that Paddock is gone. */
      readonly copy?: CopyIdentity | undefined;
    }
  | { readonly kind: 'graph'; readonly corralId: string }
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'terminal'; readonly terminalId: string }
  /** `view`: the inner tab in front; null until something names one or the person picks. */
  | { readonly kind: 'tools'; readonly view: ToolsView | null };

/** A tab's identity in the strip: two tabs with the same key are the same tab. */
export type TabKey =
  | 'files'
  | 'changes'
  | 'artifacts'
  | 'tools'
  | `document:${DocumentSource}:${string}`
  | `graph:${string}`
  | `run:${string}`
  | `terminal:${string}`;

/**
 * Every `panel` value names the tab that carries it ("탭" table). `debug` names the bottom dock's
 * debug tab, never a panel tab.
 */
export const PANEL_TAB_OF: Readonly<Record<SessionPanel, TabKind | null>> = {
  files: 'files',
  document: 'document',
  graph: 'graph',
  terminal: 'terminal',
  // 작업 carries the previews until 미리보기 is a tab of its own: `preview` is its inner tab.
  tools: 'tools',
  preview: 'tools',
  debug: null,
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
  /** For 터미널: the terminal; without one the target names no tab. */
  readonly terminal?: string | undefined;
  /** For 문서: the file's relative path; without one the target names no tab. */
  readonly file?: string | undefined;
  /** For 문서: where the file is; the conversation's Paddock unless it says the source folder. */
  readonly source?: DocumentSource | undefined;
  /** For 팀 그래프: the team; without one the target names no tab. */
  readonly corral?: string | undefined;
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
  /** Server mode with a Paddock: a terminal can be opened (the "+" list's 터미널). */
  readonly paddock?: boolean | undefined;
  /**
   * The conversation's terminals, oldest first, from a listing asked after this entry; null until
   * it answers, and null when it cannot be read (restored terminal tabs then stay).
   */
  readonly terminalIds?: readonly string[] | null | undefined;
  /**
   * The project's teams as the page read them on entry; null until then. Restored 팀 그래프 tabs
   * of a team it does not list are dropped once.
   */
  readonly corralIds?: readonly string[] | null | undefined;
  /**
   * The panel is wide (800px or more): the tree is a column beside the 문서 tabs, and 파일 is not
   * drawn in the strip while one is open (features/session-panel.md 파일 탭과 트리 열).
   */
  readonly wide?: boolean | undefined;
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
export type PlusItem = 'files' | 'terminal' | 'changes' | 'run-history' | 'artifacts' | 'tools';

export function tabKey(tab: PanelTab): TabKey {
  switch (tab.kind) {
    case 'run':
      return `run:${tab.runId}`;
    case 'terminal':
      return `terminal:${tab.terminalId}`;
    case 'document':
      return `document:${tab.source}:${tab.path}`;
    case 'graph':
      return `graph:${tab.corralId}`;
    default:
      return tab.kind;
  }
}

/** The `panel` value a tab writes when nothing inside it is in front; 작업 writes its inner tab. */
export function tabPanel(tab: PanelTab): SessionPanel {
  if (tab.kind === 'tools') return tab.view === 'preview' ? 'preview' : 'tools';
  return tab.kind;
}

/**
 * The tab a target opens. `panel=run` without `run` is the newest run's tab; with no run, or
 * before the run list is known, there is no tab (null). A named run is kept even when it is not
 * listed yet (a run just started): the run list's answer settles it (`panelRunId`).
 */
export function targetTab(target: PanelTarget, runIds: readonly string[] | null): PanelTab | null {
  const kind = PANEL_TAB_OF[target.panel];
  if (kind === null) return null;
  if (kind === 'terminal')
    return target.terminal ? { kind: 'terminal', terminalId: target.terminal } : null;
  if (kind === 'document')
    return target.file
      ? { kind: 'document', source: target.source ?? 'copy', path: target.file }
      : null;
  if (kind === 'graph') return target.corral ? { kind: 'graph', corralId: target.corral } : null;
  // `panel=tools` leaves the inner tab as it is; `panel=preview` puts 미리보기 in front.
  if (kind === 'tools')
    return { kind: 'tools', view: target.panel === 'preview' ? 'preview' : null };
  if (kind !== 'run') return { kind };
  const runId = panelRunId(
    (runIds ?? []).map((id) => ({ runId: id })),
    target.run,
    false,
  );
  return runId ? { kind: 'run', runId } : null;
}

/** The "+" list: only what can be opened now, in order; run items once the run list is known. */
export function plusItems(ctx: Pick<PanelContext, 'folder' | 'runIds' | 'paddock'>): PlusItem[] {
  const runs = (ctx.runIds?.length ?? 0) > 0;
  return [
    ...(ctx.folder ? (['files'] as const) : []),
    // Kept while a terminal cannot be made: its row is unavailable, not gone.
    ...(ctx.paddock ? (['terminal'] as const) : []),
    ...(ctx.folder ? (['changes'] as const) : []),
    ...(runs ? (['run-history', 'artifacts'] as const) : []),
    ...(ctx.paddock ? (['tools'] as const) : []),
  ];
}

/**
 * What choosing a "+" item opens; 실행 기록 is the newest run's tab. 터미널 is decided by the
 * page (a live terminal's tab where it is, or a new terminal), never here.
 */
export function plusTarget(
  item: Exclude<PlusItem, 'terminal'>,
  ctx: Pick<PanelContext, 'runIds'>,
): PanelTarget {
  if (item !== 'run-history') return { panel: item };
  const newest = ctx.runIds?.at(-1);
  return newest ? { panel: 'run', run: newest } : { panel: 'run' };
}

/** A relative path inside a folder: never absolute, never climbing out, never empty. */
export function relativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  if (value.startsWith('/') || value.includes('\0')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
