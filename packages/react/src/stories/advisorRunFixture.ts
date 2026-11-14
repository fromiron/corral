import { type CorralDefinition, type EventOf, RunEvent } from '@corral/contracts';
import {
  applyEvent,
  emptyProjection,
  type RunProjection,
  SESSION_ADVISOR_ID,
  withSessionAdvisor,
} from '@corral/core';
import { linearCorral } from '@corral/testkit';
import { sessionStore } from './fixtures.tsx';

// A run whose Reviewer advisor watches the Implementer (docs/specs/features/advisor.md): one
// person's instruction, one admitted concern and one suppressed note. Stories and tests share it.

export const ADVISOR_RUN = 'run_advisor';
export const ADVICE_TEXT =
  'The brief asks for two sources; the answer cites one.\nCheck the second claim before submitting.';

/** Options: `session` uses the advisor a conversation's session setting adds (core). */
export interface AdvisorRunOptions {
  advised?: boolean;
  session?: boolean;
}

/** The advisor's node: the team's Reviewer, or the conversation's built-in advisor. */
export const advisorNodeId = ({ session = false }: AdvisorRunOptions = {}) =>
  session ? `${SESSION_ADVISOR_ID}` : 'reviewer';

export function advisorDefinition({ session = false }: AdvisorRunOptions = {}): CorralDefinition {
  const base = linearCorral(['implementer']);
  base.nodes = base.nodes.map((node) =>
    node.id === 'implementer' ? { ...node, label: 'Implementer' } : node,
  );
  if (session) return withSessionAdvisor(base, { modelProfile: 'model-a' });
  const definition = base;
  const role = definition.roles[0] as CorralDefinition['roles'][number];
  definition.roles.push({
    ...role,
    id: 'reviewer_role',
    name: 'Reviewer',
    prompt: 'Watch the implementer.',
  });
  definition.nodes = [
    ...definition.nodes,
    {
      id: 'reviewer',
      type: 'agent',
      label: 'Reviewer',
      roleId: 'reviewer_role',
      invocation: 'observer',
      outputName: 'notes',
    },
  ];
  definition.capabilityLinks = [
    ...definition.capabilityLinks,
    { id: 'watch', kind: 'advise', sourceNodeId: 'reviewer', targetNodeId: 'implementer' },
  ];
  return definition;
}

type Draft = { [K in RunEvent['type']]: [K, EventOf<K>['payload'], string?] }[RunEvent['type']];

const usage = (outputTokens: number) => ({
  inputTokens: outputTokens * 4,
  outputTokens,
  cachedInputTokens: null,
  reasoningTokens: null,
});

/** The run's events; without `advised`, the advisor has reviewed once and said nothing. */
export function advisorRunEvents(options: AdvisorRunOptions = {}): RunEvent[] {
  const { advised = true } = options;
  const created = (executionId: string, nodeId: string, advisor = false): Draft => [
    'execution.created',
    {
      executionId,
      nodeId,
      taskId: `task_${executionId}`,
      attemptNo: 1,
      parentExecutionId: null,
      depth: 0,
      iterationId: null,
      modelProfile: 'model-a',
      ...(advisor ? { advisor: true as const } : {}),
    },
  ];
  const request = (executionId: string, modelCallId: string, tokens: number): Draft[] => [
    [
      'model.request_prepared',
      {
        executionId,
        modelCallId,
        contextSnapshotId: `snapshot_${modelCallId}`,
        profile: 'model-a',
        configRevision: 0,
        directiveIds: [],
        inputArtifactVersionIds: [],
      },
    ],
    [
      'model.finished',
      {
        executionId,
        modelCallId,
        responseRef: null,
        rawUsage: null,
        normalizedUsage: usage(tokens),
        certainty: 'reported',
      },
    ],
  ];
  const drafts: Draft[] = [
    created('impl_1', 'implementer'),
    [
      'execution.state_changed',
      { executionId: 'impl_1', from: 'queued', to: 'active', activity: 'model', waitingOn: null },
    ],
    [
      'directive.accepted',
      {
        directiveId: 'dir_user_1',
        targetExecutionId: 'impl_1',
        text: 'Keep the comparison to one page.',
        delivery: 'next_request',
        origin: 'user',
      },
      'impl_1',
    ],
    ...request('impl_1', 'call_impl_1', 300),
    created('advisor_1', advisorNodeId(options), true),
    [
      'execution.state_changed',
      {
        executionId: 'advisor_1',
        from: 'queued',
        to: 'active',
        activity: 'model',
        waitingOn: null,
      },
    ],
    ...request('advisor_1', 'call_advisor_1', 120),
    ...(advised
      ? ([
          [
            'directive.accepted',
            {
              directiveId: 'dir_advice_1',
              targetExecutionId: 'impl_1',
              text: ADVICE_TEXT,
              delivery: 'next_request',
              origin: 'advice',
            },
            'impl_1',
          ],
          [
            'advice.admitted',
            {
              adviceId: 'advice_1',
              observerExecutionId: 'advisor_1',
              targetExecutionId: 'impl_1',
              severity: 'concern',
              delivery: 'next_request',
              directiveId: 'dir_advice_1',
            },
            'advisor_1',
          ],
          [
            'advice.suppressed',
            {
              observerExecutionId: 'advisor_1',
              targetExecutionId: 'impl_1',
              severity: 'nit',
              reason: 'duplicate',
            },
            'advisor_1',
          ],
        ] satisfies Draft[])
      : []),
    [
      'execution.state_changed',
      {
        executionId: 'advisor_1',
        from: 'active',
        to: 'waiting_message',
        activity: null,
        waitingOn: {
          kind: 'message',
          targetIds: ['implementer'],
          reasonCode: 'advisor_between_reviews',
          since: '2026-11-13T00:00:10.000Z',
          deadline: null,
          required: false,
        },
      },
    ],
  ];
  return drafts.map(([type, payload, executionId], index) =>
    RunEvent.parse({
      schemaVersion: '0.1',
      eventId: `event_${index + 1}`,
      runId: ADVISOR_RUN,
      runSeq: index + 1,
      recordedAt: new Date(Date.UTC(2026, 10, 13, 0, 0, index + 1)).toISOString(),
      actor:
        type === 'directive.accepted' && payload.origin === 'user'
          ? { kind: 'user', id: 'user' }
          : type.startsWith('advice.') || type === 'directive.accepted'
            ? { kind: 'agent', id: 'advisor_1' }
            : { kind: 'runtime', id: 'runtime' },
      causedByEventIds: [],
      ...(executionId ? { executionId } : {}),
      type,
      payload,
    }),
  );
}

export function advisorRunProjection(events = advisorRunEvents()): RunProjection {
  return {
    ...events.reduce(applyEvent, emptyProjection(ADVISOR_RUN)),
    status: 'running',
  };
}

/** One more advice, as the projection records it once admitted. */
export interface AdviceDraft {
  adviceId: string;
  severity: 'nit' | 'concern' | 'blocker';
  text: string;
  /** How it goes; `preserve` keeps it on record for a target that had already ended. */
  delivery?: 'next_request' | 'interrupt' | 'preserve';
  /** Its directive's state; without one an admitted advice waits to be read. */
  status?: RunProjection['directives'][string]['status'];
  /** The request that carried it, once attached or delivered. */
  modelCallId?: string;
  target?: string;
  observer?: string;
  seq?: number;
}

/** The projection with more advice admitted, each with its directive unless it is kept. */
export function withAdvice(projection: RunProjection, drafts: readonly AdviceDraft[]) {
  const advice = { ...projection.advice };
  const directives = { ...projection.directives };
  for (const [index, draft] of drafts.entries()) {
    const delivery =
      draft.delivery ?? (draft.severity === 'blocker' ? 'interrupt' : 'next_request');
    const target = draft.target ?? 'impl_1';
    const observer = draft.observer ?? 'advisor_1';
    const seq = draft.seq ?? 100 + index;
    const directiveId = delivery === 'preserve' ? null : `dir_${draft.adviceId}`;
    advice[draft.adviceId] = {
      adviceId: draft.adviceId,
      observerExecutionId: observer,
      targetExecutionId: target,
      severity: draft.severity,
      delivery,
      directiveId,
      note: delivery === 'preserve' ? draft.text : null,
      acceptedSeq: seq,
    };
    if (directiveId && delivery !== 'preserve')
      directives[directiveId] = {
        directiveId,
        targetExecutionId: target,
        text: draft.text,
        origin: 'advice',
        delivery,
        status: draft.status ?? 'accepted',
        commandId: null,
        acceptedSeq: seq,
        contextSnapshotId: null,
        modelCallId: draft.modelCallId ?? null,
        reason: null,
        advice: {
          adviceId: draft.adviceId,
          severity: draft.severity,
          observerExecutionId: observer,
        },
      };
  }
  return {
    ...projection,
    advice,
    directives,
    directiveOrder: [
      ...projection.directiveOrder,
      ...Object.keys(directives).filter((id) => !projection.directiveOrder.includes(id)),
    ],
  };
}

/** The run ended: its roles succeeded, and the advisor with them. */
export function endedRun(projection: RunProjection): RunProjection {
  return {
    ...projection,
    status: 'succeeded',
    endedAt: '2026-11-13T00:01:00.000Z',
    executions: Object.fromEntries(
      Object.entries(projection.executions).map(([id, execution]) => [
        id,
        { ...execution, status: 'succeeded' as const, waitingOn: null, activity: null },
      ]),
    ),
  };
}

export function advisorRunSession(options: AdvisorRunOptions = {}) {
  const events = advisorRunEvents(options);
  return sessionStore({
    runId: ADVISOR_RUN,
    definition: advisorDefinition(options),
    events,
    projection: advisorRunProjection(events),
  });
}
