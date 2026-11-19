import type { TeamAssistantRequest, TeamAssistantResponse } from '@corral/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, ModelsApi } from '../src/index.ts';

const request: TeamAssistantRequest = {
  operationId: 'same-operation',
  mode: 'edit',
  messages: [{ role: 'user', content: 'Who submits?' }],
  decisions: { reviewPolicy: 'opinion_only' },
  team: { roles: [], outputs: [], brief: '', hasSharedOutrider: false },
};
const session = () => Response.json({ csrfToken: 'csrf-test' });

describe('ModelsApi.assistTeam', () => {
  it('forwards the whole request once with its operation ID, CSRF and signal', async () => {
    const response: TeamAssistantResponse = {
      reply: { kind: 'describe', topic: 'submitter' },
      model: 'Local Model',
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(Response.json(response));
    const models = new ModelsApi({ baseUrl: '', fetch });
    const { signal } = new AbortController();
    expect(await models.assistTeam(request, signal)).toEqual(response);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(url).toBe('/api/v1/team-assistant');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(new Headers(init?.headers).get('x-corral-csrf')).toBe('csrf-test');
    expect(init?.signal).toBe(signal);
  });

  it('propagates fetch cancellation without retrying', async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(session())
      .mockImplementationOnce(async (_url, init) => {
        controller.abort();
        init?.signal?.throwIfAborted();
        throw new Error('Expected forwarded signal');
      });
    const models = new ModelsApi({ baseUrl: '', fetch });
    await expect(models.assistTeam(request, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves the typed server error and never retries an unknown outcome', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'REQUEST_OUTCOME_UNKNOWN', message: 'Not resent.' } },
          { status: 409 },
        ),
      );
    const models = new ModelsApi({ baseUrl: '', fetch });
    const result = models.assistTeam(request);
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: 'REQUEST_OUTCOME_UNKNOWN',
      message: 'Not resent.',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
