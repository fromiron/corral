export const SESSION_PANELS = ['changes', 'files', 'artifacts', 'checks', 'run'] as const;
export type SessionPanel = (typeof SESSION_PANELS)[number];

/** View references only; document, process and Run owners stay in their existing stores. */
export type PanelDescriptor =
  | {
      kind: 'chat' | 'files' | 'changes' | 'artifacts' | 'checks' | 'review';
      projectId: string;
      sessionId: string;
    }
  | { kind: 'graph'; projectId: string; corralId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'file-preview'; sessionId: string; path: string }
  | { kind: 'service-preview'; sessionId: string }
  | { kind: 'terminal'; sessionId: string; terminalId: string };

const namespaces = new WeakMap<object, number>();
let nextNamespace = 0;

/** Renderer view identity only. Persistent layouts must use stable host/project identity. */
export function panelKey(services: object, panel: PanelDescriptor): string {
  let namespace = namespaces.get(services);
  if (namespace === undefined) {
    namespace = ++nextNamespace;
    namespaces.set(services, namespace);
  }
  const key = (...target: string[]) => JSON.stringify([namespace, panel.kind, ...target]);
  switch (panel.kind) {
    case 'chat':
    case 'files':
    case 'changes':
    case 'artifacts':
    case 'checks':
    case 'review':
      return key(panel.projectId, panel.sessionId);
    case 'graph':
      return key(panel.projectId, panel.corralId);
    case 'run':
      return key(panel.runId);
    case 'file-preview':
      return key(panel.sessionId, panel.path);
    case 'service-preview':
      return key(panel.sessionId);
    case 'terminal':
      return key(panel.sessionId, panel.terminalId);
  }
}
