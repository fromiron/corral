import { TERMINAL_EXECUTION_STATUSES } from '@corral/contracts';
import {
  CorralCanvas,
  createEditorStore,
  createRunSession,
  NodeInspector,
  NodePalette,
  ReinsPanel,
  RunPanel,
  type SteerTarget,
  StudioStoresProvider,
  useStudioStores,
  ValidationPanel,
} from '@corral/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { createDemoTransport } from './runtime.ts';

export function App() {
  const t = useTranslations('Studio');
  const editor = useMemo(() => createEditorStore(), []);
  const session = useMemo(() => createRunSession(createDemoTransport()), []);
  useEffect(() => () => session.getState().dispose(), [session]);

  return (
    <StudioStoresProvider editor={editor} session={session}>
      <ReactFlowProvider>
        <div className="grid h-full grid-rows-[auto_1fr]">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised px-4 py-2">
            <h1 className="text-base font-semibold">{t('title')}</h1>
            <p className="flex items-center gap-2 text-xs">
              <span className="rounded-full border border-warning px-2 py-0.5 font-semibold text-warning">
                {t('demoBadge')}
              </span>
              <span className="text-muted">{t('demoNote')}</span>
            </p>
          </header>
          <Workspace />
        </div>
      </ReactFlowProvider>
    </StudioStoresProvider>
  );
}

function Workspace() {
  return (
    <main className="grid min-h-0 grid-cols-[15rem_1fr_22rem] max-[1100px]:grid-cols-[13rem_1fr_19rem]">
      <aside className="flex min-h-0 flex-col gap-6 overflow-auto border-r border-line p-3">
        <NodePalette />
        <ValidationPanel />
      </aside>
      <div className="relative min-h-0">
        <CorralCanvas />
        <CanvasNotice />
      </div>
      <aside className="flex min-h-0 flex-col gap-6 overflow-auto border-l border-line p-3">
        <NodeInspector />
        <RunAndReins />
      </aside>
    </main>
  );
}

function RunAndReins() {
  const { editor, session } = useStudioStores();
  const [chosen, setChosen] = useState<string | null>(null);
  const projection = useStore(session, (s) => s.projection);
  const draft = useStore(editor, (s) => s.draft);

  // Steer the execution the user picked; until then, the one currently working. After the
  // run ends, the last execution stays visible read-only so expired instructions remain shown.
  const target = useMemo<SteerTarget | null>(() => {
    if (!projection) return null;
    const executions = projection.executionOrder.map((id) => projection.executions[id]);
    const execution =
      (chosen ? projection.executions[chosen] : undefined) ??
      [...executions].reverse().find((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status)) ??
      executions.at(-1);
    if (!execution) return null;
    const label = draft.nodes.find((n) => n.id === execution.nodeId)?.label ?? execution.nodeId;
    return {
      executionId: execution.executionId,
      nodeLabel: label,
      finished: TERMINAL_EXECUTION_STATUSES.has(execution.status),
    };
  }, [projection, chosen, draft.nodes]);

  return (
    <>
      <RunPanel onSteer={setChosen} />
      <ReinsPanel session={session} target={target} />
    </>
  );
}

function CanvasNotice() {
  const t = useTranslations('Canvas');
  const { editor } = useStudioStores();
  const notice = useStore(editor, (s) => s.notice);
  const nodes = useStore(editor, (s) => s.draft.nodes);
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  const text =
    notice?.kind === 'rejected'
      ? t(`rejected.${notice.reason}`)
      : notice?.kind === 'connected'
        ? t('connected', { source: labelOf(notice.source), target: labelOf(notice.target) })
        : '';
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="canvas-notice"
      className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-raised px-3 py-1 text-xs shadow empty:hidden"
    >
      {text}
    </p>
  );
}
