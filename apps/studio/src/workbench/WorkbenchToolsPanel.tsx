import { TabItem, TabPanel, Tabs, TabsList } from '@corral/react/design-kit';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { DevelopmentMode } from './DevelopmentMode.tsx';
import { PreviewLeases } from './PreviewLeases.tsx';
import { panelKey } from './panels/registry.ts';
import { ServicePreview } from './ServicePreview.tsx';
import { WorkbenchTasks } from './WorkbenchTasks.tsx';
import { WorktreeCommandPanel } from './WorktreeCommandPanel.tsx';

export type ToolsTab = 'tasks' | 'preview';

/**
 * The tools pane: Tasks (shared development mode, package scripts, copy commands) and Preview
 * (preview leases and the service preview). Both tabs stay mounted, so switching never restarts
 * a task, a lease poll or an open preview. With `onViewChange` the inner tab is the caller's
 * (the panel's 작업 tab remembers it); `view` null is a tab nobody has picked yet.
 */
export function WorkbenchToolsPanel({
  sessionId,
  projectId,
  view,
  onViewChange,
}: {
  sessionId: string;
  projectId: string;
  view?: ToolsTab | null;
  onViewChange?: (view: ToolsTab) => void;
}) {
  const services = useServices();
  const td = useTranslations('Docking');
  const tt = useTranslations('DevTasks');
  const tp = useTranslations('Preview');
  // Until the person picks a tab, the first read decides: a running preview opens Preview.
  const [own, setOwn] = useState<ToolsTab | null>(null);
  const tab = onViewChange ? (view ?? null) : own;
  const latest = useRef(tab);
  latest.current = tab;
  const setTab = (next: ToolsTab) => {
    latest.current = next;
    if (onViewChange) onViewChange(next);
    else setOwn(next);
  };
  const firstRead = useRef(true);
  return (
    <Tabs
      value={tab ?? 'tasks'}
      onValueChange={(value) => setTab(value as ToolsTab)}
      className="flex min-h-0 min-w-0 flex-col gap-2 p-3"
    >
      <TabsList aria-label={td('tools')} className="self-start">
        <TabItem value="tasks" label={tt('title')} />
        <TabItem value="preview" label={tp('tab')} />
      </TabsList>
      <TabPanel value="tasks" keepMounted className="flex min-w-0 flex-col gap-2">
        <DevelopmentMode sessionId={sessionId} />
        <WorkbenchTasks sessionId={sessionId} projectId={projectId} />
        <WorktreeCommandPanel sessionId={sessionId} />
      </TabPanel>
      <TabPanel value="preview" keepMounted className="flex min-w-0 flex-col gap-2">
        <PreviewLeases
          key={`previews:${sessionId}`}
          sessionId={sessionId}
          onRead={(running) => {
            if (!firstRead.current) return;
            firstRead.current = false;
            if (running && latest.current === null) setTab('preview');
          }}
        />
        <ServicePreview
          key={panelKey(services, { kind: 'service-preview', sessionId })}
          sessionId={sessionId}
          projectId={projectId}
        />
      </TabPanel>
    </Tabs>
  );
}
