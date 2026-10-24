import { once } from 'node:events';
import { openDatabase, SqliteModelAttemptStore } from '@corral/storage-sqlite';
import { expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { voiceSideband } from '../src/voice/sideband.ts';

it('[TC-LLM-005-N] sideband records duplicate and late usage once without storing audio or transcripts', async () => {
  const db = openDatabase(':memory:');
  const store = new SqliteModelAttemptStore(db);
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('missing loopback port');
  const connected = once(server, 'connection');
  const sideband = voiceSideband({
    callId: 'call_fixture',
    providerId: 'rtc_fixture',
    model: 'gpt-realtime',
    key: 'fixture',
    target: { hostId: 'local', sessionId: 'session_fixture' },
    store,
    connect: (url, options) => {
      expect(url).toBe('wss://api.openai.com/v1/realtime?call_id=rtc_fixture');
      return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
    },
  });
  const [socket] = (await connected) as [WebSocket];
  try {
    const response = {
      type: 'response.done',
      response: {
        id: 'response_one',
        usage: { input_tokens: 40, output_tokens: 10, input_token_details: { cached_tokens: 20 } },
      },
    };
    socket.send(JSON.stringify(response));
    socket.send(JSON.stringify(response));
    socket.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_one',
        transcript: 'private transcript',
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
    await expect.poll(() => store.list().length).toBe(2);
    const closing = sideband.close();
    socket.send(
      JSON.stringify({ ...response, response: { ...response.response, id: 'response_two' } }),
    );
    socket.close(1000);
    await closing;
    expect(store.get('voice_call_fixture')).toMatchObject({
      status: 'completed',
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 40,
        source: 'reported',
        costStatus: 'unknown',
        costUsd: null,
      },
    });
    expect(store.get('transcription_call_fixture_item_one')?.usage.inputTokens).toBe(3);
    expect(JSON.stringify(store.list())).not.toContain('private transcript');
  } finally {
    socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
