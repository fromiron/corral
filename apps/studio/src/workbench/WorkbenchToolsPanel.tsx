import { useServices } from '../services.tsx';
import { PreviewLeases } from './PreviewLeases.tsx';
import { panelKey } from './panels/registry.ts';
import { ServicePreview } from './ServicePreview.tsx';
import { WorktreeCommandPanel } from './WorktreeCommandPanel.tsx';

export function WorkbenchToolsPanel({ sessionId }: { sessionId: string }) {
  const services = useServices();
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2 p-3">
      <PreviewLeases key={`previews:${sessionId}`} sessionId={sessionId} />
      <WorktreeCommandPanel sessionId={sessionId} />
      <ServicePreview
        key={panelKey(services, { kind: 'service-preview', sessionId })}
        sessionId={sessionId}
      />
    </div>
  );
}
