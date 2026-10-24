import type { VoiceStartInput } from '@corral/client';
import type { ModelAttempt, ModelAttemptStore } from '@corral/contracts';
import WebSocket from 'ws';

/** Receives usage only; audio and transcript contents are neither stored nor logged. */
export function voiceSideband(input: {
  callId: string;
  providerId: string;
  key: string;
  model: string;
  target: VoiceStartInput['target'];
  store: ModelAttemptStore;
  connect?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const records = new Map<string, ModelAttempt>();
  const responseUsage = new Map<string, { input: number; output: number; cache: number }>();
  const create = (id: string, model: string): ModelAttempt => ({
    version: 2,
    attemptId: id,
    intent: {
      requestId: id,
      purpose: 'voice',
      revision: 0,
      owner: {
        kind: 'voice',
        id: input.callId,
        sessionId: input.target.sessionId,
        ...(input.target.runId ? { runId: input.target.runId } : {}),
      },
    },
    provider: 'openai',
    modelId: model,
    startedAt: now(),
    endedAt: null,
    status: 'started',
    payloadHash: null,
    payloadBytes: null,
    firstEventAt: null,
    failure: null,
    usage: {
      version: 2,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      source: 'unknown',
      costStatus: 'unknown',
      costUsd: null,
    },
  });
  const session = create(`voice_${input.callId}`, input.model);
  input.store.put(session);
  records.set(session.attemptId, session);
  let stopping = false;
  let closed = false;
  let forced = false;
  let persistenceError = false;
  const save = (row: ModelAttempt) => {
    try {
      input.store.put(row);
    } catch {
      persistenceError = true;
    }
  };
  const socket = (input.connect ?? ((url, options) => new WebSocket(url, options)))(
    `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(input.providerId)}`,
    {
      headers: { Authorization: `Bearer ${input.key}` },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 10000,
    },
  );
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  socket.on('message', (bytes) => {
    try {
      const event = JSON.parse(bytes.toString()) as Record<string, unknown>;
      if (event.type === 'response.done') {
        const response = event.response as
          | {
              id?: unknown;
              usage?: {
                input_tokens?: unknown;
                output_tokens?: unknown;
                input_token_details?: { cached_tokens?: unknown };
              };
            }
          | undefined;
        if (!response || typeof response.id !== 'string' || response.id.length > 200) return;
        const incoming = count(response.usage?.input_tokens),
          outgoing = count(response.usage?.output_tokens);
        if (incoming === null || outgoing === null) return;
        responseUsage.set(response.id, {
          input: incoming,
          output: outgoing,
          cache: count(response.usage?.input_token_details?.cached_tokens) ?? 0,
        });
        const values = [...responseUsage.values()];
        session.usage = {
          ...session.usage,
          source: 'reported',
          inputTokens: values.reduce((n, item) => n + item.input, 0),
          outputTokens: values.reduce((n, item) => n + item.output, 0),
          cacheReadTokens: values.reduce((n, item) => n + item.cache, 0),
        };
        session.firstEventAt ??= now();
        save(session);
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const usage = event.usage as
          | { input_tokens?: unknown; output_tokens?: unknown }
          | undefined;
        if (typeof event.item_id !== 'string' || !/^[\w.-]{1,120}$/.test(event.item_id)) return;
        const id = `transcription_${input.callId}_${event.item_id}`;
        const row = records.get(id) ?? create(id, 'gpt-4o-mini-transcribe');
        const incoming = count(usage?.input_tokens),
          outgoing = count(usage?.output_tokens);
        row.status = 'completed';
        row.endedAt ??= now();
        row.usage = {
          ...row.usage,
          inputTokens: incoming,
          outputTokens: outgoing,
          source: incoming !== null && outgoing !== null ? 'reported' : 'unknown',
        };
        records.set(id, row);
        save(row);
      }
    } catch {
      /* Invalid/non-usage events cannot alter an operation or expose their contents. */
    }
  });
  socket.on('error', () => {
    session.status = 'unknown';
    session.endedAt = now();
    save(session);
  });
  socket.on('close', (code) => {
    closed = true;
    session.status = stopping && !forced && code === 1000 ? 'completed' : 'unknown';
    session.endedAt = now();
    save(session);
  });
  return {
    async close() {
      stopping = true;
      if (persistenceError) {
        for (const row of records.values()) input.store.put(row);
        persistenceError = false;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          socket.off('close', done);
          resolve();
        };
        const timer = setTimeout(() => {
          forced = true;
          socket.terminate();
          done();
        }, 1500);
        socket.once('close', done);
      });
    },
  };
}
