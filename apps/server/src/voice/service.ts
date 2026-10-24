import { randomUUID } from 'node:crypto';
import type { VoiceCall, VoiceConfiguration, VoiceStartInput } from '@corral/client';
import type { ModelAttemptStore } from '@corral/contracts';
import type { ModelRegistry } from '../models/registry.ts';
import { voiceSideband } from './sideband.ts';

// Public GA unified WebRTC interface. No subscription/private endpoint fallback.
// https://developers.openai.com/api/docs/guides/voice-webrtc
const ENDPOINT = 'https://api.openai.com/v1/realtime/calls';
const MODELS = [{ id: 'gpt-realtime', name: 'GPT Realtime' }];
const MAX_SECONDS = 300;
const OUTPUT_TOKENS = 384;
const INSTRUCTIONS =
  'You are the voice input companion for Corral. Briefly acknowledge what the person said in their language. ' +
  'Their final transcript is sent separately to the selected Corral session. You cannot execute actions, ' +
  'approve requests, or claim a task succeeded. Never invent execution results. Keep replies to one short sentence.';

export class VoiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Registry = Pick<ModelRegistry, 'profileConfigs' | 'resolve' | 'credentials' | 'refreshStatus'>;
type Lease = {
  sideband?: ReturnType<typeof voiceSideband>;
  providerId: string;
  key: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Owns provider calls, never raw audio or transcripts. Audio goes directly over WebRTC. */
export class VoiceService {
  private readonly calls = new Map<string, Lease>();
  private creating = false;
  private closed = false;
  private unresolvedCreation = false;
  private readonly registry: Registry | null;
  private readonly options: {
    usageStore?: ModelAttemptStore;
    connectSideband?: Parameters<typeof voiceSideband>[0]['connect'];
    fetch?: typeof fetch;
    now?: () => number;
    id?: () => string;
    maxDurationSeconds?: number;
  };
  constructor(
    registry: Registry | null,
    options: {
      usageStore?: ModelAttemptStore;
      connectSideband?: Parameters<typeof voiceSideband>[0]['connect'];
      fetch?: typeof fetch;
      now?: () => number;
      id?: () => string;
      maxDurationSeconds?: number;
    } = {},
  ) {
    this.registry = registry;
    this.options = options;
  }

  private get http() {
    return this.options.fetch ?? fetch;
  }

  async configuration(): Promise<VoiceConfiguration> {
    await this.registry?.refreshStatus();
    return {
      profiles: (this.registry?.profileConfigs() ?? []).map((profile) => {
        const resolution = this.registry?.resolve(profile.id, 'live');
        const available = Boolean(
          profile.provider === 'openai' &&
            resolution?.ok &&
            resolution.snapshot.auth === 'api_key' &&
            !resolution.snapshot.endpointHash,
        );
        return {
          id: profile.id,
          available,
          ...(!available
            ? {
                reason:
                  'Live voice requires an existing OpenAI API-key profile using the official OpenAI endpoint. Subscription logins and custom endpoints are not supported.',
              }
            : {}),
        };
      }),
      models: MODELS,
      maxDurationSeconds: this.options.maxDurationSeconds ?? MAX_SECONDS,
      maxOutputTokensPerResponse: OUTPUT_TOKENS,
    };
  }

  async start(input: VoiceStartInput, signal?: AbortSignal): Promise<VoiceCall> {
    if (this.closed || this.creating || this.calls.size)
      throw new VoiceError(409, 'End the current voice call before starting another.');
    if (this.unresolvedCreation)
      throw new VoiceError(
        409,
        'A previous provider call could not be reconciled. New calls are blocked; check provider activity before restarting the server.',
      );
    this.creating = true;
    try {
      const config = await this.configuration();
      if (!config.models.some((m) => m.id === input.model))
        throw new VoiceError(400, 'Unsupported live voice model.');
      if (!config.profiles.some((p) => p.id === input.profileId && p.available))
        throw new VoiceError(403, 'The selected profile cannot use live voice.');
      if (!this.registry) throw new VoiceError(403, 'Live voice is unavailable.');
      const resolution = this.registry.resolve(input.profileId, 'live');
      if (!resolution.ok) throw new VoiceError(403, 'The selected profile is unavailable.');
      const key = await this.registry.credentials(resolution.snapshot);
      if (!key) throw new VoiceError(403, 'The selected profile has no API key.');
      if (signal?.aborted || this.closed) throw new VoiceError(409, 'Voice start was cancelled.');
      const form = new FormData();
      form.set('sdp', input.sdp);
      form.set(
        'session',
        JSON.stringify({
          type: 'realtime',
          model: input.model,
          instructions: INSTRUCTIONS,
          tools: [],
          max_output_tokens: OUTPUT_TOKENS,
          audio: {
            input: {
              transcription: { model: 'gpt-4o-mini-transcribe' },
              turn_detection: {
                type: 'server_vad',
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice: 'marin' },
          },
        }),
      );
      // Receive the provider's call ID even if the browser leaves meanwhile, then hang up.
      // Provider errors may contain request/credential data: never return their raw body.
      this.unresolvedCreation = true;
      const response = await this.http(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(25_000),
        redirect: 'error',
      });
      if (!response.ok) {
        this.unresolvedCreation = false;
        throw new VoiceError(
          502,
          'The voice provider refused the call. Check account access and billing.',
        );
      }
      const location = response.headers.get('location');
      const providerId = location?.split('/').at(-1);
      if (!providerId || !/^rtc_[A-Za-z0-9_-]+$/.test(providerId))
        throw new VoiceError(502, 'The voice provider returned an invalid call identifier.');
      const callId = (this.options.id ?? randomUUID)();
      const timer = setTimeout(
        () => void this.stop(callId).catch(() => {}),
        config.maxDurationSeconds * 1000,
      );
      timer.unref?.();
      this.calls.set(callId, { providerId, key, timer });
      this.unresolvedCreation = false;
      try {
        const sdp = await response.text();
        if (sdp.length > 128_000 || !sdp.startsWith('v=0'))
          throw new VoiceError(502, 'The voice provider returned an invalid audio connection.');
        if (signal?.aborted || this.closed) throw new VoiceError(409, 'Voice start was cancelled.');
        if (this.options.usageStore)
          this.calls.get(callId)!.sideband = voiceSideband({
            callId,
            providerId,
            key,
            model: input.model,
            target: input.target,
            store: this.options.usageStore,
            connect: this.options.connectSideband,
          });
        return {
          callId,
          target: input.target,
          sdp,
          expiresAt: new Date(
            (this.options.now ?? Date.now)() + config.maxDurationSeconds * 1000,
          ).toISOString(),
          maxOutputTokensPerResponse: OUTPUT_TOKENS,
        };
      } catch (error) {
        await this.stop(callId).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(502, 'The voice provider connection failed.');
    } finally {
      this.creating = false;
    }
  }

  async stop(callId: string): Promise<void> {
    const lease = this.calls.get(callId);
    if (!lease) return;
    const response = await this.http(`${ENDPOINT}/${lease.providerId}/hangup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lease.key}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    }).catch(() => null);
    if (!response || (!response.ok && response.status !== 404)) {
      // Keep ownership and retry without allowing a second call to bypass the limit.
      clearTimeout(lease.timer);
      lease.timer = setTimeout(() => void this.stop(callId).catch(() => {}), 5_000);
      lease.timer.unref?.();
      throw new VoiceError(502, 'Remote voice shutdown is not yet confirmed. Retrying.');
    }
    clearTimeout(lease.timer);
    await lease.sideband?.close();
    this.calls.delete(callId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.calls.keys()].map((id) => this.stop(id)));
  }
}
