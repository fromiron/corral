import type {
  VoiceClient,
  VoiceTarget,
  VoiceTranscript,
  VoiceTranscriptReceipt,
} from '@corral/client';
import { ApiError } from '@corral/client';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'responding' | 'ended' | 'error';
export type VoiceUtterance = VoiceTranscript & { receipt?: VoiceTranscriptReceipt };
export interface VoiceSnapshot {
  state: VoiceState;
  elapsedSeconds: number;
  inputTokens: number;
  outputTokens: number;
  utterances: VoiceUtterance[];
  error?: string;
}

/** Ephemeral device/session owner. No MediaRecorder, audio files, or persisted audio buffers. */
export class LiveVoiceRuntime {
  readonly target: VoiceTarget;
  private readonly api: VoiceClient;
  private readonly submit: (transcript: VoiceTranscript) => Promise<VoiceTranscriptReceipt>;
  private readonly changed: (snapshot: VoiceSnapshot) => void;
  private readonly environment: {
    media: () => Promise<MediaStream>;
    peer: () => RTCPeerConnection;
    audio: () => HTMLAudioElement;
    now: () => number;
  };
  private peer?: RTCPeerConnection;
  private media?: MediaStream;
  private channel?: RTCDataChannel;
  private audio?: HTMLAudioElement;
  private callId?: string;
  private timer?: ReturnType<typeof setInterval>;
  private abort?: AbortController;
  private epoch = 0;
  private active = false;
  private readonly seenResponses = new Set<string>();
  private readonly utteranceIds = new Map<string, string>();
  private snapshot: VoiceSnapshot = {
    state: 'idle',
    elapsedSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    utterances: [],
  };

  constructor(
    api: VoiceClient,
    target: VoiceTarget,
    submit: (transcript: VoiceTranscript) => Promise<VoiceTranscriptReceipt>,
    changed: (snapshot: VoiceSnapshot) => void,
    environment = {
      media: () =>
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        }),
      peer: () => new RTCPeerConnection(),
      audio: () => new Audio(),
      now: () => Date.now(),
    },
  ) {
    this.api = api;
    this.target = { ...target };
    this.submit = submit;
    this.changed = changed;
    this.environment = environment;
  }

  private update(patch: Partial<VoiceSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed(this.snapshot);
  }

  async start(profileId: string, model: string) {
    if (this.active) return;
    this.active = true;
    this.seenResponses.clear();
    this.utteranceIds.clear();
    const epoch = ++this.epoch;
    const current = () => this.active && this.epoch === epoch;
    const abort = new AbortController();
    this.abort = abort;
    this.update({
      state: 'connecting',
      error: undefined,
      elapsedSeconds: 0,
      inputTokens: 0,
      outputTokens: 0,
      utterances: [],
    });
    try {
      const media = await this.environment.media();
      if (!current()) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      this.media = media;
      for (const track of media.getTracks())
        track.onended = () => void this.fail('Microphone access ended.');
      const peer = this.environment.peer();
      this.peer = peer;
      const audio = this.environment.audio();
      this.audio = audio;
      audio.autoplay = true;
      peer.ontrack = (event) => {
        if (!current()) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio
          .play()
          .catch(
            () =>
              void this.fail(
                'Audio playback was blocked. Check browser permissions and reconnect.',
              ),
          );
      };
      peer.onconnectionstatechange = () => {
        if (!current()) return;
        if (['failed', 'disconnected', 'closed'].includes(peer.connectionState))
          void this.fail(
            'Voice connection ended. Reconnect to start a new call; previous audio will not be replayed.',
          );
      };
      for (const track of media.getTracks()) peer.addTrack(track, media);
      const channel = peer.createDataChannel('oai-events');
      this.channel = channel;
      channel.onopen = () => current() && this.update({ state: 'listening' });
      channel.onmessage = (event) => {
        if (!current() || typeof event.data !== 'string' || event.data.length > 128_000) return;
        try {
          this.providerEvent(JSON.parse(event.data));
        } catch {
          // Unknown/malformed provider data is not an executable command.
        }
      };
      channel.onclose = () => {
        if (current()) void this.fail('Voice connection ended. Reconnect to continue.');
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!current()) return;
      const call = await this.api.start(
        { profileId, model, target: this.target, sdp: offer.sdp ?? '' },
        abort.signal,
      );
      if (!current()) {
        await this.api.stop(call.callId);
        return;
      }
      this.callId = call.callId;
      await peer.setRemoteDescription({ type: 'answer', sdp: call.sdp });
      if (!current()) return;
      const started = this.environment.now();
      this.timer = setInterval(() => {
        this.update({ elapsedSeconds: Math.floor((this.environment.now() - started) / 1000) });
        if (this.environment.now() >= Date.parse(call.expiresAt))
          void this.fail('The voice call reached its time limit.');
      }, 1000);
    } catch (error) {
      if (current())
        await this.fail(
          error instanceof ApiError
            ? error.message
            : 'Could not start live voice. Check microphone permission, the selected profile, and provider access.',
        );
    }
  }

  /** Only final provider transcripts cross into the ordinary Corral command path. */
  providerEvent(event: Record<string, unknown>) {
    if (!this.active) return;
    if (event.type === 'input_audio_buffer.speech_started') this.update({ state: 'listening' });
    if (event.type === 'output_audio_buffer.started') this.update({ state: 'responding' });
    if (
      event.type === 'output_audio_buffer.stopped' ||
      event.type === 'output_audio_buffer.cleared'
    )
      this.update({ state: 'listening' });
    if (event.type === 'error')
      void this.fail('The voice provider reported an error. Reconnect to try again.');
    if (event.type === 'response.done' && typeof event.response === 'object' && event.response) {
      const response = event.response as {
        id?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (response.id && !this.seenResponses.has(response.id)) {
        this.seenResponses.add(response.id);
        const count = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
        this.update({
          inputTokens: this.snapshot.inputTokens + count(response.usage?.input_tokens),
          outputTokens: this.snapshot.outputTokens + count(response.usage?.output_tokens),
        });
      }
    }
    if (
      event.type !== 'conversation.item.input_audio_transcription.completed' ||
      !this.callId ||
      typeof event.item_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(event.item_id) ||
      typeof event.transcript !== 'string' ||
      !event.transcript.trim()
    )
      return;
    if (this.utteranceIds.has(event.item_id)) return;
    // Provider item IDs are opaque and can be longer than Corral's 120-char Identifier.
    // Bind them once to a call-local ordinal; retries keep this original command ID.
    const commandId = `voice_${this.callId}_${this.utteranceIds.size}`;
    this.utteranceIds.set(event.item_id, commandId);
    const utterance: VoiceUtterance = {
      text: event.transcript.trim(),
      commandId,
      target: this.target,
    };
    this.update({ utterances: [...this.snapshot.utterances, utterance] });
    void this.commit(utterance);
  }

  async retry(commandId: string, delivery?: 'queue' | 'next') {
    const utterance = this.snapshot.utterances.find((item) => item.commandId === commandId);
    if (utterance?.receipt?.status !== 'rejected') return;
    if (delivery) {
      if (!utterance.receipt.alternatives?.includes(delivery)) return;
      const next = {
        ...utterance,
        commandId: `${commandId}_${delivery}`,
        delivery,
        receipt: undefined,
      };
      if (this.snapshot.utterances.some((item) => item.commandId === next.commandId)) return;
      this.update({ utterances: [...this.snapshot.utterances, next] });
      await this.commit(next);
    } else await this.commit(utterance);
  }

  private async commit(utterance: VoiceUtterance) {
    this.update({
      utterances: this.snapshot.utterances.map((item) =>
        item.commandId === utterance.commandId ? { ...item, receipt: undefined } : item,
      ),
    });
    let receipt: VoiceTranscriptReceipt;
    try {
      receipt = await this.submit(utterance);
    } catch {
      receipt = {
        status: 'rejected',
        message: 'Submission was not confirmed. Retry uses the same command ID.',
      };
    }
    this.update({
      utterances: this.snapshot.utterances.map((item) =>
        item.commandId === utterance.commandId ? { ...item, receipt } : item,
      ),
    });
  }

  interrupt() {
    if (this.channel?.readyState !== 'open' || this.snapshot.state !== 'responding') return;
    this.channel.send(JSON.stringify({ type: 'response.cancel' }));
    this.channel.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
    this.update({ state: 'listening' });
  }

  private async fail(error: string) {
    await this.stop();
    this.update({ state: 'error', error });
  }

  async stop() {
    this.active = false;
    this.epoch++;
    this.abort?.abort();
    clearInterval(this.timer);
    for (const track of this.media?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.media = undefined;
    if (this.channel) {
      this.channel.onclose = null;
      this.channel.onmessage = null;
      this.channel.close();
    }
    this.channel = undefined;
    if (this.peer) {
      this.peer.onconnectionstatechange = null;
      this.peer.ontrack = null;
      this.peer.close();
    }
    this.peer = undefined;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
    this.audio = undefined;
    this.update({ state: 'ended' });
    const callId = this.callId;
    this.callId = undefined;
    if (callId) {
      try {
        await this.api.stop(callId);
      } catch {
        this.update({
          state: 'error',
          error: 'Microphone stopped. Remote shutdown is not confirmed; the server is retrying.',
        });
      }
    }
  }
}
