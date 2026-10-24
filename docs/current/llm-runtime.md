# Managed LLM runtime

Contract approved by [CR-052](../change-requests/CR-052-llm-runtime-modernization.md) and ADR-041. Implementation status belongs to C-179–184; live or packaged validation is separate evidence. [Product §9](product-contract.md#9-사용량-예산과-자원-정책) owns usage/resource defaults.

## Request ownership and transport

Core and SDK use the host ModelRegistry → ModelRequestRuntime path in normal and isolated workers. Intent identifies the logical request, owner, purpose and revision; each physical retry gets a separate attempt and retains the logical ID. Coordinator alone accepts task completion, revisions and file effects. Chooser/draft have operation ownership without synthetic Runs. The SQLite attempt/event ledger also receives image operation and voice call observations.

Workers measure for compaction; the execution broker's host meter uses actual sent context and reported usage for the final output allowance. Bridge enforces permit/model ceilings without replacing that measurement with a separate density estimate. Broker lifetime isolates anchors between executions.

Profile explicit values precede endpoint explicit values, matching catalog metadata, permitted environment defaults, then product defaults. Context, cache and reasoning sources are frozen; the final transport applies model capabilities. Authentication remains host-owned. Endpoint keys retain their destination binding; credentials are never persisted in policy/attempt snapshots or sent to workers. Direct network from trusted native extensions is outside the managed boundary and is not represented as fully controlled traffic.

Provider retries are zero (Bedrock maxAttempts=1). Corral allows two retries only for explicit transient errors or known pre-send failures. Retry-After precedes jittered exponential delay; cancellation interrupts waiting. Auth/quota, partial response and ambiguous delivered requests are not automatically repeated. Same operation ID returns its stored receipt; confirmed failed user operations can start a new explicit intent. Waiting does not hold a model slot. A cancelled but still-running transport retains its resource slot until termination.

IPC core 7 / SDK 8 reject mixed workers. Text, thinking and tool arguments travel as coalesced deltas, flushed within 16ms and before semantic events. Block boundaries carry only that block; final messages remain authoritative. IPC writes honor process-channel backpressure. Sequence validation replaces the lifetime 100-call limit.

## Context, cache and source access

Immutable input/history/artifact storage is distinct from model-visible projection. Host inputs without an artifact receive scoped immutable source references; `read_artifact` accepts only owned artifacts, input sources or finished owned tool results, with Unicode offsets and a maximum 8,192-character page. A partial file read is not evidence of full-file coverage.

Stable system instructions, required skills and compatible tool declarations precede changing Coordinator state. Conversation affinity includes session/role/participant/candidate/profile/harness identity. Cache retention and header/body affinity are endpoint capabilities; native DeepSeek special cases are not applied to Hive. Declared tools still require activation and permission.

Core and SDK share DSH-based density estimates, usage anchors, balanced tool boundaries, pruning and summary validation. Estimates include system, tool schemas and image estimates and are labelled estimates. Adaptive PI reserve/keep policy replaces fixed R/K defaults; explicit settings must satisfy their relationships. Reduction order is duplicate removal, range/source projection, old tool-result pruning, then summarization. Fresh or unreferenceable tool results are not silently pruned. Summary requests carry an explicit internal-compaction system instruction and host-enforced toolChoice=none; the original task output contract resumes on the next execution turn. A summary must be smaller, complete, and based on the same revision; otherwise retain the source context. Required images/current state and previous summaries survive compaction. SDK hook failure cancels compaction rather than falling through to another summarizer.

Judge evidence is projected against an aggregate model-context budget, preserving task/criteria/check verdicts and readable anonymous packet references. Excerpts do not prove omitted evidence; the judge can request source ranges. Required state that cannot fit produces an explicit preparation failure.

## Continuation and accounting

Independent meeting replies begin from one published user snapshot in parallel. Mentions/reactions follow published messages sequentially. Each participant can continue a compatible successful checkpoint with newly posted messages; model/role changes or missing checkpoint fall back to full published context. A started answer remains attached to its original user message. Secretary adoption and handoff still require their existing explicit commands.

Checkpoint v2 reuses immutable message and artifact bodies through a versioned manifest; v1 remains readable. Storage failure leaves the latest committed recovery point visible. Restart records unfinished operations as interrupted/unknown, without replaying network effects. Recovery/fork and private export validate referenced content hashes; public exports omit it.

Source closure follows owned finished tool records, not only toolResult messages still visible after compaction. The execution reuses successfully committed chunk/source references, while message snapshots and restored body hashes remain validated. Selecting one checkpoint does not hydrate every other checkpoint.

Usage reports retain reported/estimated/unknown provenance and nullable counts. Zero is not inferred from missing data. Subscription usage has no invented zero-dollar API price. Late usage settles the original attempt and Run reservation without reviving tasks. History pages are bounded and do not load the whole ledger into Settings.

Chooser Run reservations derive from the existing attempt ledger: one reservation per prepared physical request, its actual output allowance, and its reported usage or unknown remainder. No payload prepared means no model reservation. Late usage updates only the matching reservation; past snapshots and choice text are not rewritten. Callers without a managed ledger record only reported usage. The chooser prompt and visible-text gate share a 4,096-byte JSON bound; model output allowance and reasoning are separate from that byte bound.

Each physical chooser attempt has 30 seconds from provider SDK dispatch to completion. Admission and retry waits are excluded, including reacquiring a slot. User cancellation remains active while waiting and during transmission. The response timer ends with its attempt; retries use the same rule and the existing two-retry maximum.

[Port notices](../../THIRD-PARTY-NOTICES/llm-runtime-ports.md) describe pinned DSH MIT and PI LGPL sources, modifications, corresponding source distribution and rebuild/replacement steps.
