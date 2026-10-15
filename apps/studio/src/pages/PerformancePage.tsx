import { HttpSseTransport } from '@corral/client';
import type { TransportHandlers } from '@corral/core';
import {
  CorralCanvas,
  createEditorStore,
  createRunSession,
  draftFromDefinition,
  RunView,
  StudioStoresProvider,
  Timeline,
} from '@corral/react';
import { ReactFlowProvider } from '@xyflow/react';
import { useLayoutEffect, useState } from 'react';
import { useStore } from 'zustand';

// Only bundled in MODE=performance. All replay, commands and frames use the local server.
const params = new URLSearchParams(location.search);
const runId = params.get('run');
if (!runId) throw new Error('The performance harness must provide a persisted run');
const pending = new Map<number, string>();
const visible: { eventId: string; at: number }[] = [];
let measuring = false;
let frames = 0;
class MeasuredTransport extends HttpSseTransport {
  override subscribe(id: string, afterSeq: number, handlers: TransportHandlers) {
    return super.subscribe(id, afterSeq, {
      ...handlers,
      onEvent(event) {
        if (measuring) pending.set(event.runSeq, event.eventId);
        handlers.onEvent(event);
      },
      onFrame(frame) {
        if (measuring) frames++;
        handlers.onFrame?.(frame);
      },
    });
  }
}
const source = new MeasuredTransport({ baseUrl: '' });
const session = createRunSession(source);
await session.getState().open(runId);
const definition = await source.getRunDefinition(runId);
if (!definition) throw new Error('Missing persisted definition');
const nodes = definition.nodes.length;
const editor = createEditorStore(draftFromDefinition(definition));
const snapshot = await source.getSnapshot(runId);
const executionId = Object.values(snapshot.projection.executions).find(
  (execution) => execution.status === 'active',
)?.executionId;
if (!executionId) throw new Error('Performance fixture has no active execution');
const activeExecutionId = executionId;
const initialEvents = snapshot.seq;
const historicalExecutions = Object.values(snapshot.projection.executions).filter(
  (execution) => execution.status === 'succeeded',
).length;

function PaintObserver() {
  const seq = useStore(session, (state) => state.projection?.lastSeq ?? 0);
  useLayoutEffect(() => {
    const batch = [...pending].filter(([eventSeq]) => eventSeq <= seq);
    for (const [eventSeq] of batch) pending.delete(eventSeq);
    requestAnimationFrame(() => {
      for (const [, eventId] of batch) visible.push({ eventId, at: Date.now() });
    });
  }, [seq]);
  return <span data-testid="performance-seq">{seq}</span>;
}

export default function PerformancePage() {
  const [result, setResult] = useState('ready');
  const [running, setRunning] = useState(false);
  async function measure() {
    setRunning(true);
    pending.clear();
    visible.length = 0;
    frames = 0;
    const receiptMs: number[] = [];
    const begin = performance.now();
    measuring = true;
    try {
      const samples = params.get('samples') === '5' ? 5 : 100;
      for (let index = 0; index < samples; index++) {
        const at = performance.now();
        const receipt = await session
          .getState()
          .steer(activeExecutionId, `Fixed fixture directive ${index}`);
        if (receipt.status !== 'queued')
          throw new Error(`Rejected measurement command: ${receipt.status}`);
        receiptMs.push(performance.now() - at);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      setResult(
        JSON.stringify({
          transport: 'http-sse-sqlite',
          nodes,
          historicalExecutions,
          initialEvents,
          frames,
          durationMs: performance.now() - begin,
          receiptMs,
          visible: [...visible],
        }),
      );
    } catch (error) {
      setResult(JSON.stringify({ error: String(error) }));
    } finally {
      measuring = false;
      setRunning(false);
    }
  }
  return (
    <main className="p-4">
      <h2>Local server performance fixture</h2>
      <p>
        20 nodes · 100 past executions · 10,000 persisted events · 50 incoming frames per second
      </p>
      <button type="button" disabled={running} onClick={() => void measure()}>
        Run fixed benchmark
      </button>
      <output data-testid="performance-result" className="sr-only">
        {result}
      </output>
      <PaintObserver />
      <StudioStoresProvider editor={editor} session={session}>
        <ReactFlowProvider>
          <div data-testid="performance-canvas" className="h-96">
            <CorralCanvas />
          </div>
        </ReactFlowProvider>
        <div className="grid grid-cols-2 gap-4">
          <Timeline session={session} />
          <div className="h-96 overflow-auto">
            <RunView session={session} onSteer={() => {}} />
          </div>
        </div>
      </StudioStoresProvider>
    </main>
  );
}
