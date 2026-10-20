/** Same-origin authenticated settings API, using the existing session CSRF contract. */
export async function projectRequest<T>(path: string, body?: unknown): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) {
    const session = await fetch('/api/v1/session', { credentials: 'same-origin' });
    if (!session.ok) throw new Error('Open the server sign-in link again.');
    const { csrfToken } = await session.json();
    if (typeof csrfToken !== 'string') throw new Error('The session is unavailable.');
    headers.set('x-corral-csrf', csrfToken);
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? 'The operation failed.');
  return data as T;
}
export interface ProjectMaterial {
  id: string;
  projectId: string;
  kind: 'instructions' | 'memory';
  name: string;
  revision: number;
  text: string;
}
export interface CloneOperation {
  id: string;
  commandId: string;
  destination: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  progress: string;
  cleanupConfirmed: boolean;
  partialDirectory: boolean;
}
