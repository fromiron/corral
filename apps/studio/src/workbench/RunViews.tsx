import {
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  tabStripItem,
  tabStripList,
} from '@corral/react/design-kit';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

export interface RunWorkspaceView {
  id: string;
  label: string;
  render: () => ReactNode;
  testId?: string;
}

/**
 * Primary workspace views mount when visible, then retain their scroll and graph state.
 * A document read in the workspace (`reading`) sits under the view row in the place of the
 * views' content, the row showing the view it belongs to; choosing any view leaves it.
 */
export function RunViews({
  views,
  visible,
  reading,
  trailing,
}: {
  views: RunWorkspaceView[];
  visible: boolean;
  /** At the row's end, after the views: the run's own details (Run info). */
  trailing?: ReactNode;
  reading?: {
    /** The view the row shows as chosen while a document is read; null when none is. */
    view: string | null;
    /** The document's pane, kept mounted so focus can move into it as it opens. */
    pane: ReactNode;
    /** A view was chosen while the document was read. */
    onLeave: () => void;
  };
}) {
  const t = useTranslations('RunMonitor');
  const [selected, setSelected] = useState('graph');
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const viewport = useRef<HTMLDivElement>(null);
  const readingView = reading?.view ?? null;
  const choose = (id: string) => {
    setSelected(id);
    if (readingView !== null) reading?.onLeave();
  };
  useLayoutEffect(() => {
    const panel = viewport.current;
    if (!visible || !panel) return;
    const measure = () => {
      // The session can keep this workspace mounted under a hidden primary tab.
      if (panel.clientWidth > 0 && panel.clientHeight > 0)
        setVisited((previous) =>
          previous.has(selected) ? previous : new Set(previous).add(selected),
        );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [visible, selected]);
  return (
    <Tabs
      value={readingView ?? selected}
      onValueChange={(value) => choose(String(value))}
      className="flex h-full min-h-0 flex-col"
    >
      <div
        data-run-view-row=""
        className="@container/run-views flex shrink-0 items-center gap-2 border-b border-line px-4 py-2"
      >
        <TabsList aria-label={t('views')} className={tabStripList}>
          {views.map((view) => (
            <TabItem
              key={view.id}
              value={view.id}
              label={view.label}
              className={tabStripItem}
              // The view shown as chosen while reading is not a change of value; it still
              // leaves the document.
              {...(view.id === readingView ? { onClick: () => choose(view.id) } : {})}
              {...(view.testId ? { 'data-testid': view.testId } : {})}
            />
          ))}
        </TabsList>
        {trailing ? <div className="ml-auto flex shrink-0 items-center">{trailing}</div> : null}
      </div>
      {views.map((view) => (
        <TabPanel
          key={view.id}
          ref={view.id === selected ? viewport : undefined}
          value={view.id}
          keepMounted
          className="min-h-0 flex-1 overflow-auto"
          data-run-workspace-view={view.id}
          // Spread only while reading: the panel's own prop replaces the tabs' visibility.
          {...(readingView !== null ? { hidden: true } : {})}
        >
          {visited.has(view.id) ? view.render() : null}
        </TabPanel>
      ))}
      {reading?.pane}
    </Tabs>
  );
}
