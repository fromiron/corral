# CR-052: LLM request runtime modernization

- Status: approved for implementation by Bell, 2026-10-24, through the complete modernization plan in this conversation.
- Baseline: Corral `401bdf463efab4784cb25c686867ed18f2c5379c`; DeepSeek Harness `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; PI-Desktop `1a812ed7b84e0bd1b117080eb4e51c76eba35d48`.
- Tracking: C-179–184, CRL-LLM-001–006. Implementation and validation are recorded separately.

## Contract

1. New executions default to unlimited model calls, cumulative output and elapsed execution time. Explicit user budgets remain optional. Model capabilities, output/context bounds, cancellation, concurrency and process ownership still apply. Saved definitions acquire a new unlimited revision; old definitions, hashes and Run snapshots remain readable and unchanged.
2. Model admission defaults to six concurrent requests and twelve resident executions. Chooser, draft, compaction and managed extension requests share admission and durable usage accounting with worker requests. No fake Run is required for an auxiliary operation.
3. Every physical provider request has an attempt identity. Unknown usage and unknown pricing are not zero. Late usage may settle the original attempt but cannot revive a cancelled task. An ambiguous delivered request is not silently resent. Explicit transient failures and pre-send failures have at most two retries with cancellable exponential backoff, jitter and Retry-After. Provider-internal retries are disabled.
4. Core and SDK use the same context policy and host-owned network boundary. Context is a projection of immutable history. Preserve authoritative current instructions, approvals and references; do not reinsert the entire initial prompt after compaction. Prune/offload before summarizing; reject truncated, stale or non-shrinking summaries. The final provider payload is the accounting and validation boundary.
5. Keep stable instructions/tools/skills ahead of changing context. Preserve scoped conversation identity across requests and compaction. Tool declaration does not grant activation or permission. Provider-specific cache/tool capabilities are validated per endpoint, including Hive separately from native DeepSeek.
6. IPC carries incremental text, thinking and tool-argument deltas, coalesced for at most 16 ms, flushing before semantic events. There is no lifetime 100-call limit. Replay protection uses execution sequence and durable receipts.
7. Independent meeting replies use one user-message snapshot and run in parallel. Replies to published agent mentions are sequential. New user messages supersede not-yet-started older replies; started and late replies remain attached to their original message. Secretary adoption and handoff authority remain explicit.
8. Default unlimited executions warn on repeated absence of meaningful progress; a fixed number of model responses is not a termination condition. Judge context includes bounded evidence projections and readable original references. Checkpoints reuse immutable content and report the latest recoverable position on storage failure.
9. Voice sideband and image effects feed the same usage ledger with modality-specific observations. Restart does not automatically send provider requests or apply candidate changes.
10. Port the pinned MIT DSH projection, compaction, measurement, pruning and retry algorithms, and LGPL PI-Desktop budget, delta/coalescing, request usage, tool activation and affinity mechanisms. Record original files, modifications, corresponding sources, notices and rebuild/replacement instructions. Do not import Cordis or replace Coordinator ownership.

## Supersession

This CR supersedes the conflicting *new-execution* limits in Spec §9, CR-048 §5 and ADR-008; CR-037/ADR-036 fixed compaction defaults and Core-only omission; CR-049 sequential independent replies; CR-024/ADR-031 thinking-inclusive 256-byte routing limit; ADR-005/027/033 split managed transports; ADR-024 count-only no-progress pause; CR-030 whole-context checkpoint storage. Historical snapshots and evidence retain their original semantics. The newer policy does not remove D&D, Reins, tool authorization, writer ownership or revision checks.

## Verification

Before implementation, reproduce bridge call 101, model-cap/identity mismatch, quadratic delta traffic, full prompt reinjection and auxiliary accounting gaps. Cover normal, failure, cancellation, duplicate and late-event cases; compare Core/SDK and isolated/non-isolated requests. Validate multi-language and image context, paired tool calls/results, old-data migration, meeting steering and live ChatGPT/Hive requests. Paid tests stay opt-in and stop on provider quota exhaustion. Live performance distributions require 30 completed samples per compared condition or an explicit incomplete result.

See [execution plan](../plans/llm-runtime-modernization.md) for remaining work and [architecture](../current/architecture.md) for state ownership.

## Oracle simplification follow-up — 2026-10-24

Bell requested implementation of the reviewed simplifications. This clarifies §4, §8 and §10 without changing usage, permission or license policy:

- Workers estimate for compaction. Each execution broker owns a host ContextMeter updated only from its actual provider requests and observed usage; the runtime makes the final context/output decision. Bridge checks permit/model ceilings without independently estimating input again.
- Checkpoint sources include inherited/input sources and finished tool results owned by the execution, even after summarization removes their messages. Reuse only references from successful checkpoint commits. Full-snapshot IPC still requires message validation; this change does not promise fully incremental message encoding.
- Generated modernization reports/evidence are outputs, excluded from candidate identity and corresponding-source inputs. Probe/build/test code, patches, dependency metadata and license notices remain inputs. Existing evidence keeps its original identity.
- Preserve source-to-compiled-output comparison and actual worker startup checks. Run each once for a frozen candidate/toolchain; report-only updates do not trigger rebuilds or paid A/B repeats. Keep audit history and ownership, cancellation and late-usage guards.

Regressions extend TC-LLM-004-N/F, TC-RESUME-001-H/N and the existing release candidate test. The final full suite is run once after focused tests and type/contract checks; known baseline failures remain visible.

## Chooser accounting repair — 2026-10-24

Bell requested this bounded follow-up after review. Replace the remaining 256-token reservation with each prepared chooser attempt's recorded output allowance and reported usage. Retries count as separate physical calls; a cancelled or rejected request that never prepared a provider payload creates no model reservation. Unknown usage stays reserved at that attempt's allowance, and late reported usage settles the same reservation through Coordinator without restarting a Run. Historical Run events are unchanged. Non-managed callers without an attempt ledger can record reported usage but cannot invent an unknown reservation from a constant.

The chooser still requests the model's allowed output, minimum supported reasoning and compact JSON with a 4,096 UTF-8 byte maximum excluding thinking. The prompt and stream gate share the byte constant. This does not restore the old token cap or change the chosen team's reasoning policy. Extend TC-AUTO-003-H/N and TC-LLM-002-H/N/F for actual allowance, retries, unknown/zero usage, cancellation and late settlement. This follow-up runs related regressions and contract/document checks, without repeating full-suite, packaging or paid benchmarks.

## Chooser response timeout repair — 2026-10-24

Bell requested separation of slot waiting and model response time after the queue fallback was reproduced. Each physical chooser request has a 30-second response timeout starting immediately before the provider SDK is invoked, after admission and request preparation. End that timer when the physical attempt finishes. Admission, retry backoff and reacquiring a slot do not consume response time. The existing maximum of two transient retries remains unchanged; each retry receives its own response timeout. Explicit cancellation stays active during all waits and requests, and late usage still settles the original attempt without changing the chosen response. No new queue deadline, configuration setting or scheduler is added. Regressions cover a long slot wait followed by a full response allowance, cancellation while queued, retry backoff and existing unresponsive-provider timeouts.
