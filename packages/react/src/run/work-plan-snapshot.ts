import { WorkPlan } from '@corral/contracts';
import { canonicalJson } from '@corral/core';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface WorkPlanRef {
  scope: 'execution' | 'team';
  executionId: string;
  attemptNo: number;
  revision: number;
  criteriaVersionId: string;
  bodyRef: string;
  bodyHash: string;
}

interface PlanProgress {
  plan: WorkPlan;
  completed: number;
  total: number;
  planFinished: boolean;
  runFinished: boolean;
}

export type WorkPlanStatus =
  | { state: 'hidden' | 'loading' | 'error' | 'mismatch' }
  | ({ state: 'ready' | 'stale-criteria' | 'stale-attempt' } & PlanProgress);

export interface WorkPlanSnapshotInput {
  runId: string | null;
  ref: WorkPlanRef | null;
  currentCriteriaVersionId: string | null | undefined;
  currentAttemptNo?: number | null;
  runStatus?: string;
  load: (bodyRef: string, options?: { reload?: boolean }) => Promise<string | null>;
  /** The owning run store, or a transport-scoped archive reader. Never a global singleton. */
  cacheScope: object;
  text?: string;
}

type VerifiedBody = { state: 'ready'; plan: WorkPlan } | { state: 'error' | 'mismatch' };
interface CacheEntry {
  text?: string;
  promise: Promise<VerifiedBody>;
}

const caches = new WeakMap<object, Map<string, CacheEntry>>();
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

function cacheFor(scope: object) {
  let cache = caches.get(scope);
  if (!cache) {
    cache = new Map();
    caches.set(scope, cache);
  }
  return cache;
}

function identity(runId: string, ref: WorkPlanRef) {
  return JSON.stringify([
    runId,
    ref.scope,
    ref.executionId,
    ref.attemptNo,
    ref.revision,
    ref.criteriaVersionId,
    ref.bodyRef,
    ref.bodyHash,
  ]);
}

async function validate(text: string | null, ref: WorkPlanRef): Promise<VerifiedBody> {
  if (text === null) return { state: 'error' };
  let raw: unknown;
  let plan: WorkPlan;
  try {
    raw = JSON.parse(text);
    plan = WorkPlan.parse(raw);
  } catch {
    return { state: 'error' };
  }
  if (
    plan.scope !== ref.scope ||
    plan.executionId !== ref.executionId ||
    plan.attemptNo !== ref.attemptNo ||
    plan.revision !== ref.revision ||
    plan.criteriaVersionId !== ref.criteriaVersionId
  ) {
    return { state: 'mismatch' };
  }
  // Hash the recorded JSON, before schema transforms such as title trimming.
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(raw)));
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return hash === ref.bodyHash ? { state: 'ready', plan } : { state: 'mismatch' };
}

function readBody(input: WorkPlanSnapshotInput, key: string, ref: WorkPlanRef, reload: boolean) {
  const cache = cacheFor(input.cacheScope);
  const existing = cache.get(key);
  // A newly supplied body must not inherit verification of different bytes.
  if (!reload && existing && (input.text === undefined || input.text === existing.text)) {
    return existing.promise;
  }
  const entry: CacheEntry = {
    text: reload ? undefined : input.text,
    promise: Promise.resolve({ state: 'error' }),
  };
  entry.promise = Promise.resolve()
    .then(async () => {
      const text = reload
        ? await input.load(ref.bodyRef, { reload: true })
        : (input.text ?? (await input.load(ref.bodyRef)));
      if (text !== null) entry.text = text;
      return validate(text, ref);
    })
    .catch((): VerifiedBody => ({ state: 'error' }))
    .then((result) => {
      // Failure remains visible to this consumer but cannot poison later retries.
      if (result.state !== 'ready' && cache.get(key) === entry) cache.delete(key);
      return result;
    });
  cache.set(key, entry);
  return entry.promise;
}

/** One immutable, verified plan read shared by the composer and historical details. */
export function useWorkPlanSnapshot(input: WorkPlanSnapshotInput): {
  status: WorkPlanStatus;
  retry: () => void;
} {
  const { runId, ref, cacheScope, text } = input;
  const key = runId && ref ? identity(runId, ref) : null;
  const latest = useRef(input);
  latest.current = input;
  const reloadRequest = useRef<{ key: string; cacheScope: object } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    cacheScope: object;
    text: string | undefined;
    attempt: number;
    body: VerifiedBody;
  } | null>(null);

  useEffect(() => {
    const currentInput = latest.current;
    const currentRef = currentInput.ref;
    if (!key || !currentRef) return;
    const reload =
      reloadRequest.current?.key === key && reloadRequest.current.cacheScope === cacheScope;
    reloadRequest.current = null;
    let current = true;
    void readBody(currentInput, key, currentRef, reload).then((body) => {
      if (current) setResult({ key, cacheScope, text, attempt, body });
    });
    return () => {
      current = false;
    };
  }, [key, cacheScope, text, attempt]);

  const retry = useCallback(() => {
    if (key) {
      cacheFor(cacheScope).delete(key);
      reloadRequest.current = { key, cacheScope };
    }
    setAttempt((value) => value + 1);
  }, [cacheScope, key]);

  if (!key) return { status: { state: 'hidden' }, retry };
  if (
    result?.key !== key ||
    result.cacheScope !== cacheScope ||
    result.text !== text ||
    result.attempt !== attempt
  ) {
    return { status: { state: 'loading' }, retry };
  }
  if (result.body.state !== 'ready') return { status: result.body, retry };
  const plan = result.body.plan;
  const completed = plan.items.filter((item) => item.status === 'completed').length;
  const progress: PlanProgress = {
    plan,
    completed,
    total: plan.items.length,
    planFinished: completed === plan.items.length,
    runFinished: TERMINAL.has(input.runStatus ?? 'running'),
  };
  const state =
    input.currentAttemptNo != null && input.currentAttemptNo !== plan.attemptNo
      ? 'stale-attempt'
      : input.currentCriteriaVersionId && input.currentCriteriaVersionId !== plan.criteriaVersionId
        ? 'stale-criteria'
        : 'ready';
  return { status: { state, ...progress }, retry };
}
