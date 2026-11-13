import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import type { RunProjection, RunSummary } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { createStore } from 'zustand/vanilla';
import { useServices } from '../../../services.tsx';
import { type SteerTarget, targetsOf } from '../../composerIntent.ts';

// What the composer reads from the session's runs: the executions an instruction can reach,
// and the newest final result a question can be about.

const NO_TARGETS: { targets: SteerTarget[]; lead: string | null } = { targets: [], lead: null };

/**
 * Executions of the session's run that can take an instruction now, read from the run's live
 * projection (features/composer-flow.md "계약"): the store the conversation already follows,
 * so an execution that ends while the person types leaves the list at once, without polling.
 * `ready` is false until that projection is read, so a send never guesses the target.
 */
export function useSteerTargets(
  ownActive: RunSummary | null,
  restored: { target: string | null; targetLabel: string | null },
) {
  const { runFor, retainRun } = useServices();
  const runId = ownActive?.runId ?? null;
  const store = runId ? runFor(runId) : null;
  useEffect(() => {
    if (!runId || !store) return;
    const release = retainRun(runId);
    void store.getState().open(runId);
    return release;
  }, [store, runId, retainRun]);
  const view = useStore(
    store ?? EMPTY_STORE,
    useShallow((state) => ({
      runId: state.runId,
      projection: state.projection,
      definition: state.definition,
      failed: Boolean(state.streamError || state.missingRunId),
    })),
  );
  const current = Boolean(runId && view.runId === runId && view.projection?.runId === runId);
  const read = useMemo(
    () => (current && view.projection ? targetsOf(view.projection, view.definition) : NO_TARGETS),
    [current, view.projection, view.definition],
  );
  // Names of executions seen, so an instruction for one that ended still says whom it was for.
  const targetNames = useRef(
    new Map<string, string>(
      restored.target && restored.targetLabel ? [[restored.target, restored.targetLabel]] : [],
    ),
  );
  for (const x of read.targets) targetNames.current.set(x.id, x.label);
  // A run whose record cannot be read takes no instruction; the composer queues instead.
  const ready = !runId || current || (view.runId === runId && view.failed);
  return { targets: read.targets, lead: read.lead, ready, targetNames };
}

// Read while the session has no run going: nothing to follow.
const EMPTY_STORE = createStore(() => ({
  runId: null,
  projection: null,
  definition: null,
  streamError: null,
  missingRunId: null,
})) as unknown as RunSessionStore;

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
