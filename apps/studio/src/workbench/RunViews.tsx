import { TabItem, TabPanel, Tabs, TabsList } from '@corral/react/design-kit';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

export interface RunWorkspaceView {
  id: string;
  label: string;
  render: () => ReactNode;
  testId?: string;
}

/** Primary workspace views mount when visible, then retain their scroll and graph state. */
export function RunViews({ views, visible }: { views: RunWorkspaceView[]; visible: boolean }) {
  const t = useTranslations('RunMonitor');
  const [selected, setSelected] = useState('graph');
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const viewport = useRef<HTMLDivElement>(null);
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
    <Tabs value={selected} onValueChange={setSelected} className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 overflow-x-auto border-b border-line px-4 py-2">
        <TabsList aria-label={t('views')}>
          {views.map((view) => (
            <TabItem
              key={view.id}
              value={view.id}
              label={view.label}
              {...(view.testId ? { 'data-testid': view.testId } : {})}
            />
          ))}
        </TabsList>
      </div>
      {views.map((view) => (
        <TabPanel
          key={view.id}
          ref={view.id === selected ? viewport : undefined}
          value={view.id}
          keepMounted
          className="min-h-0 flex-1 overflow-auto"
          data-run-workspace-view={view.id}
        >
          {visited.has(view.id) ? view.render() : null}
        </TabPanel>
      ))}
    </Tabs>
  );
}
