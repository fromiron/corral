import { Select, TabItem, TabsList } from '@corral/react/design-kit';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { PANE_CATALOG } from '../panels/registry.ts';
import { TopbarViews, useTopbarHostsViews } from '../TopbarSlot.tsx';
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
 * The session's view tabs (in the page top bar when one hosts them), the one pane switcher of a
 * narrow host, and the run controls. Rendered inside the session's Tabs.
 */
export function DockTopBar({
  sessionView,
  fileWork,
  compact,
  active,
  panels,
  controls,
  openContext,
  onSelectPane,
}: {
  sessionView: PrimaryView;
  /** Files and Changes show once a folder is linked or file work was opened. */
  fileWork: boolean;
  /** A narrow host shows one pane at a time. */
  compact: boolean;
  /** The active pane's id. */
  active: string;
  panels: { id: string; title: string }[];
  controls?: ReactNode;
  openContext: (view: DockContextView, notify?: boolean) => void;
  onSelectPane: (id: string) => void;
}) {
  const t = useTranslations('Docking');
  const viewsInTopbar = useTopbarHostsViews();
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
        <div className={viewsInTopbar ? 'flex items-center' : 'corral-dock-primary-tabs'}>
          <TabsList aria-label={t('sessionViews')}>
            {primaryTabs.map((view) => (
              <TabItem
                key={view}
                value={view}
                label={t(view === 'run' ? 'history' : view)}
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
          <Select
            label={t('panes')}
            placeholder={t('panes')}
            size="sm"
            value={active}
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
      {controls ? <div className="corral-dock-controls">{controls}</div> : null}
    </>
  );
}
