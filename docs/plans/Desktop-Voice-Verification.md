# ABS-15 live voice implementation evidence

Implementation uses the public OpenAI Realtime unified WebRTC call operation.
The user chooses an existing OpenAI API-key profile explicitly. Subscription OAuth
and custom endpoints are rejected, with the reason visible in the dialog. Neither
an API key nor a reusable provider token is sent to Studio.

Sources checked on 2026-10-20:

- [WebRTC unified interface](https://developers.openai.com/api/docs/guides/voice-webrtc)
- [Create call](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create)
- [Hang up call](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/hangup)
- [Realtime client events and VAD interruption](https://developers.openai.com/api/reference/resources/realtime/client-events)

The voice adapter uses `gpt-realtime`, `gpt-4o-mini-transcribe`, and voice `marin`
through that supported operation. Access is checked by the actual provider when
the person connects; a configured chat profile does not prove Realtime entitlement.
No new credential was created and no paid provider call was made during implementation.

## Product path

Session composer → Live voice → explicit API-key profile → Connect → browser
microphone and WebRTC audio/data channel → server SDP exchange → bidirectional
audio. Corral never records raw microphone audio or writes audio buffers to files,
logs or the database. The disclosure explains that OpenAI receives the audio and
final transcripts become normal session entries.

The call pins host origin, session, run and execution. Final transcript item IDs
produce stable command IDs; partial/repeated/late events never create commands.
The existing `startNext` and `transport.sendCommand(steer)` paths own execution,
with ordinary entry persistence. A waiting/ended pinned execution presents explicit
queue/next choices. Accepted steer receipts remain accepted, not falsely delivered.
Retries preserve the original command's model/policy/destination closure.

Closing the dialog, leaving its session, page teardown, microphone permission loss,
connection loss and explicit End stop microphone tracks, audio output, channel and
peer. Reconnect creates a new provider call without replaying microphone audio.
Server call ownership remains until hangup is confirmed; a failed hangup retries.
An uncertain creation response without a provider call ID blocks further call creation
instead of silently retrying a potentially billable operation. An operator must check
provider activity before restarting that server. Host origin is validated alongside
the existing authenticated session/CSRF boundary and run/session ownership.

Calls have a server 300-second limit and 384 output tokens per response. The dialog
shows elapsed time and provider response input/output token totals. These are
operational limits, not a dollar quote or a combined Corral Run budget: transcription
charges are separate and the UI says to use account billing for actual cost.

## Verification performed

`pnpm exec vitest run apps/server/test/voice.test.ts apps/studio/src/workbench/live-voice-runtime.test.ts --maxWorkers=1`

Ten tests passed using injected HTTP/device adapters:

- public multipart SDP/session configuration and secret exclusion;
- subscription/custom endpoint denial and provider error redaction;
- concurrent-call refusal, idempotent hangup, late cancelled call cleanup;
- elapsed-time server hangup and failed-hangup ownership retention;
- unknown provider-call creation blocks subsequent paid create attempts;
- run/session mismatch rejection before external calls;
- final-only transcript submission and stable retry IDs;
- explicit queue choice with deduplication;
- late microphone grant/provider answer cleanup;
- interruption, usage deduplication and microphone permission loss cleanup.

The tests exercise the production adapter/state machine, but do not verify real
microphone hardware, speaker playback, network traversal, provider account entitlement,
or a paid provider transcript reaching the Coordinator. Those require an explicitly
bounded live validation with a supported configured account. They are not claimed as
completed. Browser verification of the entry and unavailable state is tracked in the
overall UI evidence separately.
