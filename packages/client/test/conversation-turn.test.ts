import { expect, it, vi } from 'vitest';
import { HttpSseTransport } from '../src/index.ts';

it('reads one conversation turn at its run address without fetching artifact bodies', async () => {
  const turn = {
    runId: 'run_a',
    request: 'Question',
    answer: 'Answer',
    status: 'succeeded',
    artifactVersionId: 'artv_primary',
  };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(turn));
  const transport = new HttpSseTransport({ baseUrl: 'http://localhost', fetch: fetcher });
  expect(await transport.getConversationTurn('run_a')).toEqual(turn);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    'http://localhost/api/v1/runs/run_a/conversation-turn',
  );
});

it('treats an unavailable conversation turn as absent, but does not hide authentication errors', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'TARGET_NOT_FOUND', message: 'no turn' } }, { status: 404 }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'SESSION_REQUIRED', message: 'sign in' } }, { status: 401 }),
    );
  const transport = new HttpSseTransport({ baseUrl: 'http://localhost', fetch: fetcher });
  expect(await transport.getConversationTurn('missing')).toBeNull();
  await expect(transport.getConversationTurn('private')).rejects.toThrow();
});

it('rejects a conversation turn belonging to another run', async () => {
  const transport = new HttpSseTransport({
    baseUrl: 'http://localhost',
    fetch: async () =>
      Response.json({
        runId: 'other',
        request: 'Private',
        answer: 'Other answer',
        status: 'succeeded',
        artifactVersionId: 'other_artifact',
      }),
  });
  await expect(transport.getConversationTurn('requested')).rejects.toThrow(/match/i);
});
