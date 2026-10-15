import {
  type AgentStartInput,
  DecisionAnswer,
  type DecisionFailureReason,
  type DecisionProvider,
  type DecisionProviderSnapshot,
  EFFORT_LEVELS,
  type EffortFeatures,
  type EffortQuestion,
  type RunDecisionSettings,
  type RunEvent,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AdmissionObserver, ObserverContext, ObserverDraft } from '../admission/index.ts';
import { canonicalJson } from '../canonical-json.ts';
import type { RunProjection } from '../projection.ts';

// reasoning_effort judgments, observe only (CR-003, ADR-025). A judgment starts after a model
// request is committed, uses only that request's committed facts, and is recorded as
// decision.* events. It never changes a permit, a reservation or what the worker sends.

/** How a runtime judges: which providers exist and what the workspace asked for. */
export interface JudgmentConfig {
  providers: readonly DecisionProvider[];
  settings: {
    reasoning_effort: {
      mode: 'off' | 'observe';
      /** Provider ids, at most two (two = side-by-side comparison, plan v0.1 §11). */
      providers: readonly string[];
      /** Judgment calls per run; default the run's model request limit, at most 100. */
      maxCalls?: number;
      /** External providers are refused unless the workspace opted in (CR-003 §3.5). */
      allowExternal?: boolean;
    };
  };
}

export const DECISION_HARD_CAP = 100;
const EXCERPT_CHARS = 1_500;

/** The settings a run starts with: fixed for the whole run (`run.started.decisions`). */
export function resolveDecisionSettings(
  config: JudgmentConfig,
  run: { mode: 'mock' | 'live'; maxModelCalls: number },
): RunDecisionSettings {
  const wanted = config.settings.reasoning_effort;
  const providers = wanted.providers.slice(0, 2).map((id): DecisionProviderSnapshot => {
    const provider = config.providers.find((p) => p.id === id);
    if (!provider)
      return {
        id,
        version: 'unknown',
        privacy: 'local',
        available: false,
        reason: 'not installed',
      };
    const base = { id, version: provider.version, privacy: provider.privacy };
    if (!provider.questions.some((q) => q.kind === 'reasoning_effort' && q.version === 1))
      return { ...base, available: false, reason: 'does not answer reasoning_effort v1' };
    if (provider.privacy === 'external' && (run.mode !== 'live' || !wanted.allowExternal))
      return {
        ...base,
        available: false,
        reason: 'external providers run only in live runs the workspace opted in to',
      };
    const available = provider.available();
    return available === true
      ? { ...base, available: true, reason: null }
      : { ...base, available: false, reason: available };
  });
  return {
    reasoning_effort: {
      mode: wanted.mode,
      providers,
      maxCalls: Math.min(DECISION_HARD_CAP, wanted.maxCalls ?? run.maxModelCalls),
    },
  };
}

/** Code points, as the judge models count them. */
const head = (text: string, n: number) => Array.from(text).slice(0, n).join('');

/** Features and excerpt of one committed request (CR-003 §3.5). */
export function effortInput(
  projection: RunProjection,
  input: AgentStartInput,
  modelCallId: string,
): EffortQuestion['input'] {
  const execution = projection.executions[input.executionId];
  const call = projection.modelCalls[modelCallId];
  const directives = (call?.directiveIds ?? []).flatMap((id) => {
    const text = projection.directives[id]?.text;
    return text ? [text] : [];
  });
  const reviewInput = input.inputs.find((i) => i.name === 'review' && i.artifactVersionId);
  const review = Object.values(projection.reviews).find(
    (r) => r.reviewVersionId === reviewInput?.artifactVersionId,
  );
  const tools = Object.values(projection.toolCalls)
    .filter((t) => t.executionId === input.executionId)
    .map((t) => t.name)
    .slice(-10);
  const features: EffortFeatures = {
    outputContract: input.role.outputContract,
    assignment: input.assignment.kind,
    round: input.round,
    lastReviewVerdict: review?.verdict ?? null,
    inputArtifacts: input.inputs.filter((i) => i.artifactVersionId).length,
    inputChars: input.inputs.reduce((sum, i) => sum + Array.from(i.text).length, 0),
    directives: directives.length,
    requestNo: Math.max(1, (execution?.modelCallIds.indexOf(modelCallId) ?? -1) + 1),
    recentTools: tools,
  };
  const brief = input.inputs.find((i) => i.name === 'brief')?.text ?? '';
  const assignment =
    input.assignment.kind === 'delegated'
      ? input.assignment.brief
      : input.assignment.kind === 'question'
        ? input.assignment.body
        : '';
  const excerpt = head(
    [assignment, brief, ...directives.map((d) => `instruction: ${d}`)].filter(Boolean).join('\n'),
    EXCERPT_CHARS,
  );
  return { features, excerpt };
}

const inputHash = (input: EffortQuestion['input']) =>
  bytesToHex(sha256(utf8ToBytes(canonicalJson(input))));

export interface DecisionHubDeps {
  /** The run's fixed settings, or null when it has none. */
  settingsOf(runId: string): RunDecisionSettings | null;
  /** The input the execution was started with. */
  startInputOf(runId: string, executionId: string): AgentStartInput | null;
  providers: readonly DecisionProvider[];
}

/**
 * Asks each available provider about each committed model request and records the answer.
 * Registered as an admission observer, so it runs after the commit and cannot block it.
 */
export function createDecisionHub(deps: DecisionHubDeps): AdmissionObserver {
  const calls = new Map<string, number>();
  const limited = new Set<string>();
  return {
    id: 'reasoning_effort',
    version: 1,
    on: 'model.prepared',
    handle: (view, context) => {
      const event = view.event;
      if (event.type !== 'model.request_prepared') return;
      const settings = deps.settingsOf(context.runId)?.reasoning_effort;
      if (settings?.mode !== 'observe') return;
      const input = deps.startInputOf(context.runId, event.payload.executionId);
      if (!input) return;
      const providers = settings.providers.flatMap((snapshot) => {
        const provider = snapshot.available
          ? deps.providers.find((p) => p.id === snapshot.id)
          : undefined;
        return provider ? [provider] : [];
      });
      if (providers.length === 0) return;
      const question: EffortQuestion = {
        questionKind: 'reasoning_effort',
        questionVersion: 1,
        candidates: EFFORT_LEVELS,
        subject: {
          runId: context.runId,
          executionId: event.payload.executionId,
          attemptNo: input.attemptNo,
          modelCallId: event.payload.modelCallId,
          contextSnapshotId: event.payload.contextSnapshotId,
        },
        input: effortInput(view.projection, input, event.payload.modelCallId),
      };
      for (const provider of providers) {
        const used = calls.get(context.runId) ?? 0;
        if (used >= settings.maxCalls) {
          if (!limited.has(context.runId)) {
            limited.add(context.runId);
            context.record([
              {
                type: 'limit.reached',
                payload: {
                  limitKind: 'decision_calls',
                  used,
                  reserved: 0,
                  max: settings.maxCalls,
                },
              },
            ]);
          }
          return;
        }
        calls.set(context.runId, used + 1);
        judge(provider, question, context);
      }
    },
  };
}

function judge(provider: DecisionProvider, question: EffortQuestion, context: ObserverContext) {
  const { subject } = question;
  const decisionId = context.nextId();
  const headFields = {
    decisionId,
    questionKind: question.questionKind,
    questionVersion: question.questionVersion,
    provider: `${provider.id}@${provider.version}`,
    subject: {
      executionId: subject.executionId,
      attemptNo: subject.attemptNo,
      modelCallId: subject.modelCallId,
      contextSnapshotId: subject.contextSnapshotId,
    },
  };
  const recorded = context.record([
    {
      type: 'decision.requested',
      executionId: subject.executionId,
      payload: {
        ...headFields,
        privacy: provider.privacy,
        inputHash: inputHash(question.input),
        features: question.input.features,
      },
    },
  ]);
  if (!recorded) return;
  // An external provider receives the excerpt: that send is an effect, admitted only while the
  // run is running and recorded before anything leaves (CR-003 §3.5).
  let effectId: string | null = null;
  if (provider.privacy === 'external') {
    if (context.status() !== 'running') {
      context.record([
        {
          type: 'decision.failed',
          executionId: subject.executionId,
          payload: { ...headFields, reason: 'unavailable', latencyMs: 0 },
        },
      ]);
      return;
    }
    effectId = context.nextEffectId();
    const admitted = context.record([
      {
        type: 'effect.admitted',
        executionId: subject.executionId,
        payload: {
          effectId,
          kind: 'decision',
          scope: subject.executionId,
          epoch: subject.attemptNo,
          reservationId: null,
        },
      },
    ]);
    if (!admitted) return;
  }
  const started = context.monotonicMs();
  const listeners = new Set<() => void>();
  let settled = false;
  let aborted = false;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    for (const listener of listeners) listener();
  };
  const settle = (draft: ObserverDraft) => {
    if (settled) return;
    settled = true;
    stopTimer();
    stopCancel();
    abort();
    const outcome =
      draft.type === 'decision.observed'
        ? 'succeeded'
        : (draft.payload as { reason?: string }).reason === 'cancelled'
          ? 'cancelled'
          : 'failed';
    context.record(
      effectId
        ? [
            draft,
            {
              type: 'effect.settled',
              executionId: subject.executionId,
              payload: { effectId, outcome },
            },
          ]
        : [draft],
    );
  };
  const fail = (reason: DecisionFailureReason) =>
    settle({
      type: 'decision.failed',
      executionId: subject.executionId,
      payload: {
        ...headFields,
        reason,
        latencyMs: Math.max(0, Math.round(context.monotonicMs() - started)),
      },
    });
  const stopTimer = context.after(provider.timeoutMs, () => fail('timeout'));
  const stopCancel = context.onCancel(subject.executionId, () => fail('cancelled'));
  const cancellation = {
    get aborted() {
      return aborted;
    },
    onCancel(fn: () => void) {
      listeners.add(fn);
      if (aborted) fn();
      return () => {
        listeners.delete(fn);
      };
    },
  };
  let answer: Promise<unknown>;
  try {
    answer = provider.decide(question, cancellation);
  } catch {
    fail('provider_error');
    return;
  }
  answer.then(
    (raw) => {
      if (settled) return;
      const parsed = DecisionAnswer.safeParse(raw);
      if (!parsed.success) {
        fail('invalid_response');
        return;
      }
      settle({
        type: 'decision.observed',
        executionId: subject.executionId,
        payload: {
          ...headFields,
          answer: parsed.data.answer,
          probabilities: parsed.data.probabilities,
          evidenceLevel: parsed.data.evidenceLevel,
          latencyMs: Math.max(0, Math.round(context.monotonicMs() - started)),
          // Filled in by the Coordinator from the run as committed when this is recorded.
          readyBeforeDispatch: false,
          afterRequestFinished: false,
        },
      });
    },
    () => fail('provider_error'),
  );
}

/** Timing facts of a judgment, from the run as committed right now. */
export function requestTiming(projection: RunProjection, modelCallId: string) {
  const dispatched = Object.values(projection.effects).some(
    (effect) => effect.reservationId === modelCallId && effect.dispatched,
  );
  return {
    readyBeforeDispatch: !dispatched,
    afterRequestFinished: projection.modelCalls[modelCallId]?.finished === true,
  };
}

export type { RunEvent };
