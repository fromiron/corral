/** A voice call pins its destination; changing the visible tab never changes this value. */
export interface VoiceTarget {
  hostId: string;
  sessionId: string;
  runId?: string;
  executionId?: string;
}

export interface VoiceProfile {
  id: string;
  available: boolean;
  reason?: string;
}

export interface VoiceConfiguration {
  profiles: VoiceProfile[];
  models: { id: string; name: string }[];
  maxDurationSeconds: number;
  maxOutputTokensPerResponse: number;
}

export interface VoiceStartInput {
  profileId: string;
  model: string;
  target: VoiceTarget;
  sdp: string;
}

export interface VoiceCall {
  callId: string;
  target: VoiceTarget;
  sdp: string;
  expiresAt: string;
  maxOutputTokensPerResponse: number;
}

export interface VoiceClient {
  configuration(): Promise<VoiceConfiguration>;
  start(input: VoiceStartInput, signal?: AbortSignal): Promise<VoiceCall>;
  stop(callId: string): Promise<void>;
}

export interface VoiceTranscript {
  text: string;
  commandId: string;
  target: VoiceTarget;
  delivery?: 'queue' | 'next';
}

export interface VoiceTranscriptReceipt {
  status: 'accepted' | 'delivered' | 'queued' | 'rejected';
  message?: string;
  alternatives?: ('queue' | 'next')[];
}
