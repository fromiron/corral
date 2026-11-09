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

type ToolsTab = 'tasks' | 'preview';

/**
 * The tools pane: Tasks (shared development mode, package scripts, copy commands) and Preview
 * (preview leases and the service preview). Both tabs stay mounted, so switching never restarts
 * a task, a lease poll or an open preview.
 */
export function WorkbenchToolsPanel({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: string;
}) {
  const services = useServices();
  const td = useTranslations('Docking');
  const tt = useTranslations('DevTasks');
  const tp = useTranslations('Preview');
  // Until the person picks a tab, the first read decides: a running preview opens Preview.
  const [tab, setTab] = useState<ToolsTab | null>(null);
  const firstRead = useRef(true);
  return (
    <Tabs
      size="compact"
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
            if (running) setTab((current) => current ?? 'preview');
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
