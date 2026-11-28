import type { Schedule, ScheduleDraft, ScheduledOccurrence } from '@corral/contracts';

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (method !== 'GET') {
    const session = await fetch('/api/v1/session', { credentials: 'same-origin' });
    if (!session.ok)
      throw Object.assign(new Error('Open this server’s sign-in link again.'), {
        code: 'SESSION_INVALID',
      });
    const { csrfToken } = (await session.json()) as { csrfToken?: string };
    if (!csrfToken)
      throw Object.assign(new Error('The server session has expired.'), {
        code: 'SESSION_INVALID',
      });
    headers.set('x-corral-csrf', csrfToken);
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`/api/v1/schedules${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw Object.assign(new Error(value?.error?.message ?? 'The schedule could not be saved.'), {
      status: response.status,
      code: value?.error?.code,
    });
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export const schedulesApi = {
  list: () => request<{ schedules: Schedule[] }>(),
  create: (draft: ScheduleDraft) => request<Schedule>('', 'POST', draft),
  update: (schedule: Schedule, draft: ScheduleDraft) =>
    request<Schedule>(`/${schedule.id}`, 'PUT', { expectedRevision: schedule.revision, draft }),
  remove: (schedule: Schedule) =>
    request<void>(`/${schedule.id}`, 'DELETE', { expectedRevision: schedule.revision }),
  history: (id: string) => request<{ occurrences: ScheduledOccurrence[] }>(`/${id}/occurrences`),
  run: (schedule: Schedule, commandId: string) =>
    request<{ occurrences: ScheduledOccurrence[] }>(`/${schedule.id}/run`, 'POST', {
      expectedRevision: schedule.revision,
      commandId,
    }),
};
