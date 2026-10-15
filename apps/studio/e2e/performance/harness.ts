import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHost, CorralDefinition } from '@corral/contracts';
import { startCorralServer } from '@corral/server';
import { linearCorral, ScriptedAgentAdapter } from '@corral/testkit';
import { test as base, expect } from '@playwright/test';
import {
  openReadOnlyDatabase,
  SqliteRunStore,
} from '../../../../packages/storage-sqlite/src/index.ts';

const definition: CorralDefinition = linearCorral(
  ['entry', ...Array.from({ length: 16 }, (_, i) => `agent_${i + 1}`)],
  'performance_fixture',
);
for (const node of definition.nodes) {
  if (node.type === 'agent' && node.id !== 'entry') node.loopId = 'loop';
}
const reviewer = definition.roles.at(-1);
if (!reviewer) throw new Error('Fixture has no reviewer');
reviewer.outputContract = 'review';
definition.nodes.push(
  { id: 'loop', type: 'loop', label: 'Repeat', maxIterations: 10 },
  {
    id: 'decision',
    type: 'decision',
    label: 'Review',
    loopId: 'loop',
    mode: 'review',
    rule: 'review_verdict',
    inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'agent_16' }],
  },
);
definition.controlEdges = [
  { id: 'enter', source: 'entry', sourcePort: 'out', target: 'loop', targetPort: 'enter' },
  { id: 'body', source: 'loop', sourcePort: 'body', target: 'agent_1', targetPort: 'in' },
  ...definition.controlEdges.slice(1, -1),
  { id: 'review', source: 'agent_16', sourcePort: 'out', target: 'decision', targetPort: 'in' },
  { id: 'repeat', source: 'decision', sourcePort: 'revise', target: 'loop', targetPort: 'repeat' },
  { id: 'pass', source: 'decision', sourcePort: 'pass', target: 'loop', targetPort: 'exit' },
  { id: 'next', source: 'loop', sourcePort: 'next', target: 'output', targetPort: 'in' },
];

export const test = base.extend<{
  performanceServer: {
    open(samples?: number): Promise<void>;
    startFrames(): () => void;
    injectDelay(milliseconds: number): void;
    committed: Map<string, number>;
    persisted(): { events: number; commands: number; executions: number };
  };
}>({
  performanceServer: async ({ page }, use) => {
    const workspace = mkdtempSync(join(tmpdir(), 'corral-performance-'));
    let resolveReady!: (value: { host: AgentHost; runId: string }) => void;
    const ready = new Promise<{ host: AgentHost; runId: string }>((resolve) => {
      resolveReady = resolve;
    });
    let executions = 0;
    // Real graph executions and commits; only agent/model answers are synthetic.
    const agents = new ScriptedAgentAdapter({
      turns: 0,
      review: () => 'revise',
      async script(input, host) {
        if (++executions !== 101) return null;
        resolveReady({ host, runId: input.runId });
        return new Promise(() => {});
      },
    });
    const server = await startCorralServer({
      workspace,
      port: 0,
      staticDir: join(import.meta.dirname, '../..', 'dist-performance'),
      agents,
    });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let stopFrames = () => {};
    let detach = () => {};
    try {
      const started = server.coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'cmd_perf_start',
        definition,
        mode: 'mock',
      });
      if (!started.runId) throw new Error(JSON.stringify(started.receipt));
      const fixtureRunId = started.runId;
      const { host, runId } = await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(JSON.stringify(server.coordinator.getSnapshot(fixtureRunId)))),
            30_000,
          );
          timers.add(timer);
        }),
      ]);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const old = await host.prepareModelRequest();
      const observation = {
        kind: 'model_completed' as const,
        modelCallId: old.modelCallId,
        text: 'Synthetic completed request',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      await host.observe(observation);
      const active = await host.prepareModelRequest();
      // Duplicate late observations are genuine Coordinator decisions, written with FULL sync.
      while (server.coordinator.getSnapshot(runId).seq < 10_000) await host.observe(observation);
      expect(server.coordinator.getSnapshot(runId).seq).toBe(10_000);
      const committed = new Map<string, number>();
      detach = server.coordinator.subscribe(runId, 10_000, (event) =>
        committed.set(event.eventId, Date.now()),
      );
      let delayMs = 0;
      const submit = server.coordinator.submit.bind(server.coordinator);
      server.coordinator.submit = (command) => {
        // Test-only stall before the real SQLite commit; the normal server is unchanged.
        if (delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
        return submit(command);
      };
      const subscribe = server.coordinator.subscribe.bind(server.coordinator);
      server.coordinator.subscribe = (id, cursor, onEvent, ...rest) =>
        subscribe(
          id,
          cursor,
          (event) => {
            if (!delayMs || event.runSeq <= 10_000) return onEvent(event);
            const timer = setTimeout(() => {
              timers.delete(timer);
              onEvent(event);
            }, delayMs);
            timers.add(timer);
          },
          ...rest,
        );
      const external: string[] = [];
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === server.url) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      await use({
        committed,
        async open(samples = 100) {
          await page.goto(
            `${server.url}/performance?run=${runId}&samples=${samples}#${server.bootstrapUrl.split('#')[1]}`,
          );
        },
        startFrames() {
          const begin = performance.now();
          let frames = 0;
          const timer = setInterval(() => {
            const due = Math.floor((performance.now() - begin) / 20);
            while (frames < due)
              host.streamText({ modelCallId: active.modelCallId, chunkIndex: frames++, text: 'x' });
          }, 20);
          stopFrames = () => clearInterval(timer);
          return stopFrames;
        },
        injectDelay(milliseconds) {
          delayMs = milliseconds;
        },
        persisted() {
          const db = openReadOnlyDatabase(join(workspace, '.corral/corral.db'));
          try {
            const store = new SqliteRunStore(db);
            const stored = store.getRun(runId);
            return {
              events: store.readEvents(runId, 0).length,
              commands: (
                db.prepare('SELECT count(*) AS n FROM commands WHERE run_id = ?').get(runId) as {
                  n: number;
                }
              ).n,
              executions: Object.keys(stored?.projection.executions ?? {}).length,
            };
          } finally {
            db.close();
          }
        },
      });
      expect(external).toEqual([]);
    } finally {
      stopFrames();
      detach();
      for (const timer of timers) clearTimeout(timer);
      await server.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  },
});

export { expect };
