import type { RunProjection } from './projection.ts';
import type { NewSessionEntry, SessionEntry, WorkSession } from './repository/index.ts';

// The rules follow a sample repository's usage-limit recovery (`limitRecoveryCommand`): a window
// already over when the failure arrived starts nothing, and a time a day past is left to a person.

const MINUTE = 60_000;
export const RESEND_MIN_LEAD_MS = 10 * MINUTE;
// ChatGPT's reset arrives rounded to the minute.
export const RESEND_MARGIN_MS = MINUTE;
export const RESEND_MAX_OVERDUE_MS = 24 * 60 * MINUTE;

export interface SessionResend {
  of: string;
  runId: string;
  notBefore: string;
}

const time = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString() === iso ? ms : null;
};

export function usageLimitResetAt(projection: RunProjection): string | null {
  let latest: number | null = null;
  for (const id of projection.executionOrder) {
    const resetAt = projection.executions[id]?.usageLimit?.resetAt;
    const ms = resetAt ? time(resetAt) : null;
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function resendEntry(
  session: WorkSession,
  runId: string,
  projection: RunProjection,
  nowMs: number,
): NewSessionEntry | null {
  if (projection.status !== 'failed' || session.meeting) return null;
  const resetAt = usageLimitResetAt(projection);
  const resetMs = resetAt ? time(resetAt) : null;
  if (resetMs === null || resetMs - nowMs < RESEND_MIN_LEAD_MS) return null;
  const source = session.entries.find(
    (entry) => entry.runId === runId && (entry.intent === 'next' || entry.intent === 'queue'),
  );
  if (!source?.start || source.resend) return null;
  if (session.entries.some((entry) => entry.resend?.runId === runId)) return null;
  return {
    intent: 'queue',
    state: 'queued',
    text: source.text,
    start: source.start,
    ...(source.permissionMode ? { permissionMode: source.permissionMode } : {}),
    ...(source.harness ? { harness: source.harness } : {}),
    ...(source.taskScope ? { taskScope: source.taskScope } : {}),
    ...(source.verificationScope ? { verificationScope: source.verificationScope } : {}),
    ...(source.attachments?.length ? { attachments: source.attachments } : {}),
    ...(source.images?.length ? { images: source.images } : {}),
    ...(source.references?.length ? { references: source.references } : {}),
    resend: {
      of: source.entryId,
      runId,
      notBefore: new Date(resetMs + RESEND_MARGIN_MS).toISOString(),
    },
  };
}

export type ResendStep =
  | { kind: 'wait'; until: string }
  | { kind: 'start' }
  | { kind: 'dismiss' }
  | { kind: 'hold' };

export function resendStep(
  entry: SessionEntry,
  session: WorkSession,
  latestEndedRunId: string | null,
  nowMs: number,
): ResendStep {
  const resend = entry.resend;
  const notBefore = resend ? time(resend.notBefore) : null;
  if (!resend || notBefore === null) return { kind: 'hold' };
  if (latestEndedRunId !== resend.runId) return { kind: 'dismiss' };
  if (session.archivedAt || !session.autoStart) return { kind: 'hold' };
  if (nowMs < notBefore) return { kind: 'wait', until: resend.notBefore };
  if (nowMs - notBefore > RESEND_MAX_OVERDUE_MS) return { kind: 'hold' };
  return { kind: 'start' };
}

export function validResend(resend: unknown): resend is SessionResend {
  if (!resend || typeof resend !== 'object') return false;
  const value = resend as Record<string, unknown>;
  return (
    Object.keys(value).length === 3 &&
    typeof value.of === 'string' &&
    value.of.length > 0 &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    typeof value.notBefore === 'string' &&
    time(value.notBefore) !== null
  );
}
