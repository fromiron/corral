import type { SessionAdvisor } from '@corral/core';

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
