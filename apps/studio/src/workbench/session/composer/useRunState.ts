import { TERMINAL_EXECUTION_STATUSES, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection, RunSummary } from '@corral/core';
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../../services.tsx';

// What the composer reads from the session's runs: the executions an instruction can reach,
// and the newest final result a question can be about.

/** Executions that can still take an instruction, named by their node. */
export function useSteerTargets(
  ownActive: RunSummary | null,
  restored: { target: string | null; targetLabel: string | null },
) {
  const { transport } = useServices();
  const [targets, setTargets] = useState<{ id: string; label: string }[]>([]);
  const [targetTick, setTargetTick] = useState(0);
  // Names of executions seen, so an instruction for one that ended still says whom it was for.
  const targetNames = useRef(
    new Map<string, string>(
      restored.target && restored.targetLabel ? [[restored.target, restored.targetLabel]] : [],
    ),
  );
  useEffect(() => {
    void targetTick;
    if (!ownActive) return setTargets([]);
    let live = true;
    void Promise.all([
      transport.getSnapshot(ownActive.runId),
      transport.getRunDefinition(ownActive.runId),
    ]).then(([{ projection }, definition]) => {
      if (!live) return;
      const open = projection.executionOrder
        .map((id) => projection.executions[id])
        .filter((e) => e && !TERMINAL_EXECUTION_STATUSES.has(e.status));
      setTargets(
        open.flatMap((e) =>
          e
            ? [
                {
                  id: e.executionId,
                  label: `${definition?.nodes.find((n) => n.id === e.nodeId)?.label ?? e.nodeId} · #${projection.executionOrder.indexOf(e.executionId) + 1}`,
                },
              ]
            : [],
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [transport, ownActive, targetTick]);
  // An execution may end while the person types: the list follows it.
  useEffect(() => {
    if (!ownActive) return;
    const timer = setInterval(() => setTargetTick((n) => n + 1), 1500);
    return () => clearInterval(timer);
  }, [ownActive]);
  for (const x of targets) targetNames.current.set(x.id, x.label);
  return { targets, targetNames };
}

function finalResultId(projection: RunProjection): string | null {
  return projection.output?.artifactVersionIds[0] ?? null;
}

/** The newest final result among the session's ended runs. */
export function useLatestResult(runs: RunSummary[]) {
  const { transport } = useServices();
  const [latest, setLatest] = useState<{ runId: string; id: string; label: string } | null>(null);
  // Newest first; a joined key so the lookup reruns only when the ended runs change.
  const key = runs
    .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
    .map((r) => r.runId)
    .reverse()
    .join(',');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const runId of key ? key.split(',') : []) {
        const { projection } = await transport.getSnapshot(runId);
        const id = finalResultId(projection);
        const artifact = id ? projection.artifacts[id] : undefined;
        if (id && artifact) {
          if (live) setLatest({ runId, id, label: `${artifact.name} v${artifact.version}` });
          return;
        }
      }
      if (live) setLatest(null);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, key]);
  return latest;
}
