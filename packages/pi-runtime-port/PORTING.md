# Port provenance and verification

Upstream: [PI-Desktop 1a812ed7b84e0bd1b117080eb4e51c76eba35d48](https://github.com/vastsa/pi-desktop/tree/1a812ed7b84e0bd1b117080eb4e51c76eba35d48), LGPL-3.0-only. No later upstream revision is mixed in.

| Upstream file | Corral file | Adaptation and original fixture correspondence |
|---|---|---|
| agent-runtime/src/context-budget.ts | src/context-budget.ts | Same proportional reserve/retention calculation; clamp small windows and use actual model maximum. Adapter context-policy and SDK settings tests cover small-window and zero overrides. |
| agent-runtime/src/stream-coalescer.ts; shared/src/message-stream.ts | src/stream.ts | Pi event deltas replace UI events. Flush semantic boundaries, preserve redacted thinking, rebuild mutable partials. Adapter model-bridge-modernization tests cover 64 KiB/64-byte fixture, block transitions, cancellation and mutable partial duplication. |
| agent-runtime/src/request-usage.ts | src/request-usage.ts | One observation per terminal message/result, with an awaited durable Corral sink. Server request-runtime tests cover duplicate terminal observation, missing/explicit-zero usage and late cancellation accounting. |
| agent-runtime/src/session-affinity.ts | src/session-affinity.ts | Preserve explicit keys and adapter validation order; require explicit endpoint capability instead of assuming every custom gateway accepts the header/body fields. Upstream fixture values and key-preservation cases are adapted in test/ports.test.ts. |
| agent-runtime/src/fixed-tool-declarations.ts; system-transcript.ts | src/fixed-tool-declarations.ts | Keep sorted declarations and snapshot identity separate from active execution permissions. Original native DeepSeek route and function limit remain scoped; unsupported routes skip the catalog calculation. test/ports.test.ts retains ordering, identity, route, capacity and activation fixtures. |

Corral uses its existing Pi 1.3.0, Node 24, SQLite and Zod dependencies. No separate desktop or orchestration runtime is imported. See NOTICE.md for replacement/rebuild instructions; the generated SPDX inventory names the exact upstream commits and shipped notices contain both GNU license texts.
