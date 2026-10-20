import type { VoiceCall, VoiceClient, VoiceTranscriptReceipt } from '@corral/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveVoiceRuntime, type VoiceSnapshot } from './live-voice-runtime.ts';

const target = { hostId: 'local', sessionId: 'session_a', runId: 'run_a', executionId: 'exec_a' };
const utterance = {
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: 'item_1',
  transcript: 'Check the build.',
};
function setup() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const media = { getTracks: () => [track] } as unknown as MediaStream;
  const channel = {
    readyState: 'open',
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onmessage: null,
    onclose: null,
  } as unknown as RTCDataChannel;
  const peer = {
    addTrack: vi.fn(),
    close: vi.fn(),
    createOffer: async () => ({ type: 'offer', sdp: 'v=0' }),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    createDataChannel: () => channel,
  } as unknown as RTCPeerConnection;
  const audio = {
    pause: vi.fn(),
    play: vi.fn(async () => {}),
    srcObject: null,
  } as unknown as HTMLAudioElement;
  const call: VoiceCall = {
    callId: 'call_a',
    target,
    sdp: 'v=0',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    maxOutputTokensPerResponse: 384,
  };
  const api = {
    start: vi.fn(async () => call),
    stop: vi.fn(async () => {}),
  } as unknown as VoiceClient;
  const submit = vi.fn<(input: unknown) => Promise<VoiceTranscriptReceipt>>(async () => ({
    status: 'accepted',
  }));
  let snapshot: VoiceSnapshot | undefined;
  const environment = {
    media: vi.fn(async () => media),
    peer: () => peer,
    audio: () => audio,
    now: () => Date.now(),
  };
  const runtime = new LiveVoiceRuntime(
    api,
    target,
    submit,
    (next) => {
      snapshot = next;
    },
    environment,
  );
  return {
    runtime,
    api,
    submit,
    track,
    media,
    peer,
    channel,
    audio,
    environment,
    call,
    snapshot: () => snapshot,
  };
}
afterEach(() => vi.useRealTimers());

it('[TC-ABS-015-H] only final transcripts use a stable command ID and pinned execution, never partial/replayed events', async () => {
  const test = setup();
  await test.runtime.start('primary', 'gpt-realtime');
  test.runtime.providerEvent({
    ...utterance,
    type: 'conversation.item.input_audio_transcription.delta',
  });
  expect(test.submit).not.toHaveBeenCalled();
  test.runtime.providerEvent(utterance);
  test.runtime.providerEvent(utterance);
  await Promise.resolve();
  expect(test.submit).toHaveBeenCalledTimes(1);
  expect(test.submit.mock.calls[0]?.[0]).toMatchObject({
    commandId: 'voice_call_a_0',
    target,
  });
  expect(test.snapshot()?.utterances[0]?.receipt?.status).toBe('accepted');
  test.runtime.interrupt();
  expect(test.channel.send).not.toHaveBeenCalled();
  test.runtime.providerEvent({ type: 'output_audio_buffer.started' });
  test.runtime.interrupt();
  expect(test.channel.send).toHaveBeenCalledWith('{"type":"response.cancel"}');
  expect(test.channel.send).toHaveBeenCalledWith('{"type":"output_audio_buffer.clear"}');
  await test.runtime.stop();
  expect(test.track.stop).toHaveBeenCalled();
  expect(test.peer.close).toHaveBeenCalled();
  expect(test.audio.srcObject).toBeNull();
  expect(test.api.stop).toHaveBeenCalledWith('call_a');
  test.runtime.providerEvent({ ...utterance, item_id: 'late' });
  expect(test.submit).toHaveBeenCalledTimes(1);
});

it('[TC-ABS-015-N] lost command answers retry the same ID; explicit queue choice is distinct and deduplicated', async () => {
  const test = setup();
  test.submit.mockRejectedValueOnce(new Error('network lost'));
  await test.runtime.start('primary', 'gpt-realtime');
  test.runtime.providerEvent(utterance);
  await Promise.resolve();
  await test.runtime.retry('voice_call_a_0');
  expect(test.submit.mock.calls[0]?.[0]).toMatchObject({ commandId: 'voice_call_a_0' });
  expect(test.submit.mock.calls[1]?.[0]).toMatchObject({ commandId: 'voice_call_a_0' });
  test.submit.mockResolvedValueOnce({
    status: 'rejected',
    alternatives: ['queue'],
    message: 'Awaiting approval',
  });
  test.runtime.providerEvent({ ...utterance, item_id: 'item_2' });
  await Promise.resolve();
  await test.runtime.retry('voice_call_a_1', 'queue');
  await test.runtime.retry('voice_call_a_1', 'queue');
  expect(test.submit.mock.calls.at(-1)?.[0]).toMatchObject({
    commandId: 'voice_call_a_1_queue',
    delivery: 'queue',
    target,
  });
  expect(test.submit).toHaveBeenCalledTimes(4);
  await test.runtime.stop();
});

it('[TC-ABS-015-N] stops late microphone grant and late provider answer after user ends connecting', async () => {
  const test = setup();
  let grant!: (value: MediaStream) => void;
  test.environment.media.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  const connecting = test.runtime.start('primary', 'gpt-realtime');
  await test.runtime.stop();
  grant(test.media);
  await connecting;
  expect(test.track.stop).toHaveBeenCalledTimes(1);
  expect(test.api.start).not.toHaveBeenCalled();
  const next = setup();
  let answer!: (value: VoiceCall) => void;
  vi.mocked(next.api.start).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const pending = next.runtime.start('primary', 'gpt-realtime');
  await vi.waitFor(() => expect(next.api.start).toHaveBeenCalled());
  await next.runtime.stop();
  answer(next.call);
  await pending;
  expect(next.api.stop).toHaveBeenCalledWith('call_a');
  expect(next.peer.setRemoteDescription).not.toHaveBeenCalled();
});

it('[TC-ABS-015-H] reports provider usage once per response and clears the microphone on permission revocation', async () => {
  const test = setup();
  await test.runtime.start('primary', 'gpt-realtime');
  const event = {
    type: 'response.done',
    response: { id: 'r1', usage: { input_tokens: 31, output_tokens: 22 } },
  };
  test.runtime.providerEvent(event);
  test.runtime.providerEvent(event);
  expect(test.snapshot()).toMatchObject({ inputTokens: 31, outputTokens: 22 });
  test.track.onended?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(test.track.stop).toHaveBeenCalled();
  expect(test.api.stop).toHaveBeenCalledWith('call_a');
});
