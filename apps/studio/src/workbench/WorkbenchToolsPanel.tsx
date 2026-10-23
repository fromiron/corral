import { useServices } from '../services.tsx';
import { DevelopmentMode } from './DevelopmentMode.tsx';
import { PreviewLeases } from './PreviewLeases.tsx';
import { panelKey } from './panels/registry.ts';
import { ServicePreview } from './ServicePreview.tsx';
import { WorkbenchTasks } from './WorkbenchTasks.tsx';
import { WorktreeCommandPanel } from './WorktreeCommandPanel.tsx';

export function WorkbenchToolsPanel({
  sessionId,
  projectId,
}: {
  sessionId: string;
  projectId: string;
}) {
  const services = useServices();
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2 p-3">
      <DevelopmentMode sessionId={sessionId} />
      <PreviewLeases key={`previews:${sessionId}`} sessionId={sessionId} />
      <WorkbenchTasks sessionId={sessionId} projectId={projectId} />
      <WorktreeCommandPanel sessionId={sessionId} />
      <ServicePreview
        key={panelKey(services, { kind: 'service-preview', sessionId })}
        sessionId={sessionId}
        projectId={projectId}
      />
    </div>
  );
}
