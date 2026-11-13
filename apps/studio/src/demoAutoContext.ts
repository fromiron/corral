import type { AutoRunStart } from '@corral/client';
import type { SessionAdvisor, WorkSession } from '@corral/core';

/**
 * What the browser demo admits a request with, read as the server reads it when it admits one
 * (`startAutoRun`): the stored session's completion criteria and its advisor
 * (features/advisor.md "두는 곳", 대화).
 */
export function demoAutoContext(
  session: { criteria?: string[]; advisor?: SessionAdvisor | null } | null | undefined,
  { fileTools, signal }: { fileTools: boolean; signal?: AbortSignal | undefined },
): {
  fileTools: boolean;
  signal?: AbortSignal;
  sessionCriteria?: string[];
  sessionAdvisor?: SessionAdvisor;
} {
  return {
    fileTools,
    ...(signal ? { signal } : {}),
    ...(session?.criteria?.length ? { sessionCriteria: session.criteria } : {}),
    ...(session?.advisor ? { sessionAdvisor: session.advisor } : {}),
  };
}

/**
 * The browser demo's `startAuto`: the session is read when the request is admitted, and files are
 * offered where the session has a working copy.
 */
export function demoStartAuto<R>({
  worktree,
  getSession,
  start,
}: {
  worktree: (sessionId: string) => Promise<unknown>;
  getSession: (sessionId: string) => Promise<WorkSession | null>;
  start: (request: AutoRunStart, context: ReturnType<typeof demoAutoContext>) => Promise<R>;
}) {
  return async (request: AutoRunStart, signal?: AbortSignal): Promise<R> => {
    const copy = await worktree(request.sessionId).catch(() => null);
    const session = await getSession(request.sessionId);
    return start(request, demoAutoContext(session, { fileTools: Boolean(copy), signal }));
  };
}
