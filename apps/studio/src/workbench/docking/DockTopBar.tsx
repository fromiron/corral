import { Select, TabItem, TabsList } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { PANE_CATALOG } from '../panels/registry.ts';
import { TopbarViews, useTopbarHostsViews, useTopbarLayout } from '../TopbarSlot.tsx';
import type { DockContextView } from './layout.ts';

export type PrimaryView = 'chat' | 'files' | 'changes' | 'run';
/** The session view a pane is shown in. */
export function primaryViewFor(view: DockContextView): PrimaryView {
  if (view === 'chat') return 'chat';
  if (view === 'run' || view === 'artifacts') return 'run';
  if (view === 'changes' || view === 'git' || view === 'checks' || view === 'problems')
    return 'changes';
  return 'files';
}
const groupLabel = { develop: 'groupDevelop', verify: 'groupVerify', run: 'groupRun' } as const;

/**
 * The session's view tabs (in the page top bar when one hosts them) and the one pane switcher
 * of a narrow host; the run's controls are the activity bar's. Rendered inside the session's Tabs. A top bar too narrow
 * for the tabs shows them as one menu; the tabs stay in the document, hidden, so each panel
 * keeps its name.
 */
export function DockTopBar({
  sessionView,
  fileWork,
  compact,
  panels,
  changeCount = 0,
  openContext,
  onSelectView,
  onSelectPane,
}: {
  sessionView: PrimaryView;
  /** Files and Changes show once a folder is linked or file work was opened. */
  fileWork: boolean;
  /** A narrow host shows one pane at a time. */
  compact: boolean;
  /** The active pane's id. Its own tab names it, so the narrow switcher does not show it. */
  active: string;
  panels: { id: string; title: string }[];
  /** Files this session changed: a quiet count on the Changes view. */
  changeCount?: number;
  openContext: (view: DockContextView, notify?: boolean) => void;
  /** Switches the session view, as choosing its tab does. */
  onSelectView: (view: PrimaryView) => void;
  onSelectPane: (id: string) => void;
}) {
  const t = useTranslations('Docking');
  const viewsInTopbar = useTopbarHostsViews();
  const folded = useTopbarLayout().views === 'menu' && viewsInTopbar;
  const viewLabel = (view: PrimaryView) => t(view === 'run' ? 'history' : view);
  const counted = (view: PrimaryView) => view === 'changes' && changeCount > 0;
  const primaryTabs: PrimaryView[] = [
    'chat',
    ...(fileWork ? (['files', 'changes'] as const) : []),
    'run',
  ];
  // Opening a pane lists every pane once, under what it is for (#70 IA-04).
  const paneOptions = PANE_CATALOG.filter((entry) => primaryViewFor(entry.view) === 'files').map(
    (entry) => ({
      value: `context:${entry.view}`,
      label: t(entry.view),
      group: t(groupLabel[entry.group]),
    }),
  );
  return (
    <>
      {/* The session's views share the top bar's one row; standalone hosts keep their own. */}
      <TopbarViews>
        {/* The menu stays in the document too, hidden while the tabs fit: the bar tries a
            roomier tier whenever its content changes (another view's run pill), and a menu
            mounted again for it would drop the keyboard focus it holds. */}
        {viewsInTopbar ? (
          <div hidden={!folded} className="contents">
            <Select
              variant="chip"
              align="end"
              label={t('sessionViews')}
              value={sessionView}
              onValueChange={onSelectView}
              options={primaryTabs.map((view) => ({
                value: view,
                label: counted(view) ? (
                  <span className="flex items-center gap-1.5">
                    {viewLabel(view)}
                    <span className="text-muted-foreground tabular-nums">{changeCount}</span>
                  </span>
                ) : (
                  viewLabel(view)
                ),
              }))}
            />
          </div>
        ) : null}
        <div
          hidden={folded}
          className={viewsInTopbar ? 'flex items-center' : 'corral-dock-primary-tabs'}
        >
          <TabsList aria-label={t('sessionViews')}>
            {primaryTabs.map((view) => (
              <TabItem
                key={view}
                value={view}
                label={viewLabel(view)}
                // The tab's name is its word once. Its panel is named by it, and a folded (hidden)
                // tab would otherwise lend the panel its width-reserving copy of the word too.
                aria-label={viewLabel(view)}
                // The count is a quiet mark after the word, not part of the tab's name.
                {...(counted(view)
                  ? {
                      'aria-description': t('changedFiles', { count: changeCount }),
                      'data-count': changeCount,
                      className:
                        'after:text-caption after:text-muted-foreground after:tabular-nums after:content-[attr(data-count)]',
                    }
                  : {})}
                onClick={() => {
                  if (sessionView === view && (view === 'changes' || view === 'run'))
                    openContext(view, true);
                }}
              />
            ))}
          </TabsList>
        </div>
      </TopbarViews>
      {compact && sessionView === 'files' ? (
        <div className="corral-dock-toolbar" data-testid="dock-toolbar">
          {/* The pane's own tab names the one in front; the switcher reads Panes, not that name
              again, and still reaches every pane. */}
          <Select<string>
            label={t('panes')}
            placeholder={t('panes')}
            value={null}
            onValueChange={(id) => onSelectPane(id)}
            options={[
              ...paneOptions,
              ...panels
                .filter(
                  (panel) => panel.id.startsWith('document:') || panel.id.startsWith('graph:'),
                )
                .map((panel) => ({ value: panel.id, label: panel.title })),
            ]}
          />
        </div>
      ) : null}
    </>
  );
}
