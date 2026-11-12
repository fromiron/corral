# Managed LLM runtime

[Product §9](product-contract.md#9-사용량과-자원-정책) owns usage/resource defaults.

## Request ownership and transport

Core and SDK use the host ModelRegistry → ModelRequestRuntime path in normal and isolated workers. Intent identifies the logical request, owner, purpose and revision; each physical retry gets a separate attempt and retains the logical ID. Coordinator alone accepts task completion, revisions and file effects. Chooser/draft have operation ownership without synthetic Runs. The SQLite attempt/event ledger also receives image operation and voice call observations.

Workers measure for compaction; the execution broker's host meter uses actual sent context and reported usage for the final output allowance. Bridge enforces permit/model ceilings without replacing that measurement with a separate density estimate. Broker lifetime isolates anchors between executions.

Profile explicit values precede endpoint explicit values, matching catalog metadata, permitted environment defaults, then product defaults. Context, cache and reasoning sources are frozen; the final transport applies model capabilities. Authentication remains host-owned. Endpoint keys retain their destination binding; credentials are never persisted in policy/attempt snapshots or sent to workers. Direct network from trusted native extensions is outside the managed boundary and is not represented as fully controlled traffic.

The host request permit compares the provider's JSON payload after decoding its actual supported transport encoding. Plain JSON and the subscription transport's zstd-compressed JSON retain the same approved model, destination, method, payload, and one-send boundary. Malformed or unsupported encodings and changed decoded payloads are rejected before dispatch; the approved original wire body is sent unchanged.

Provider retries are zero (Bedrock maxAttempts=1). Corral allows two retries only for explicit transient errors or known pre-send failures. Retry-After precedes jittered exponential delay; cancellation interrupts waiting. Auth/quota, partial response and ambiguous delivered requests are not automatically repeated. Same operation ID returns its stored receipt; confirmed failed user operations can start a new explicit intent. Waiting does not hold a model slot. A cancelled but still-running transport retains its resource slot until termination.

IPC core 8 / SDK 9 reject mixed workers. Text, thinking and tool arguments travel as coalesced deltas, flushed within 16ms and before semantic events. Block boundaries carry only that block; final messages remain authoritative. IPC writes honor process-channel backpressure. Sequence validation replaces the lifetime 100-call limit.

## Context, cache and source access

Immutable input/history/artifact storage is distinct from model-visible projection. Host inputs without an artifact receive scoped immutable source references; `read_artifact` accepts only owned artifacts, input sources or finished owned tool results, with Unicode offsets and a maximum 8,192-character page. A partial file read is not evidence of full-file coverage.

Stable system instructions, required skills and compatible tool declarations come first. A session follow-up's copied turns follow them, then the current assignment, then changing Coordinator state. Turns are rendered identically in each follow-up, so a later request's prefix repeats the earlier one's; the first follow-up shares only system instructions and tools with the first request. Conversation affinity includes session/role/participant/candidate/profile/harness identity. Cache retention and header/body affinity are endpoint capabilities; native DeepSeek special cases are not applied to Hive. Declared tools still require activation and permission.

Core and SDK share DSH-based density estimates, usage anchors, balanced tool boundaries, pruning and summary validation. Estimates include system, tool schemas and image estimates and are labelled estimates. Adaptive PI reserve/keep policy replaces fixed R/K defaults; explicit settings must satisfy their relationships. Reduction order is duplicate removal, range/source projection, old tool-result pruning, then summarization. Fresh or unreferenceable tool results are not silently pruned. Summary requests carry an explicit internal-compaction system instruction and host-enforced toolChoice=none; the original task output contract resumes on the next execution turn. A summary must be smaller, complete, and based on the same revision; otherwise retain the source context. Required images/current state and previous summaries survive compaction. SDK hook failure cancels compaction rather than falling through to another summarizer.

Judge evidence is projected against an aggregate model-context budget, preserving task/criteria/check verdicts and readable anonymous packet references. Excerpts do not prove omitted evidence; the judge can request source ranges. Required state that cannot fit produces an explicit preparation failure.

## Continuation and accounting

A session follow-up names the newest ended run it continues. The Coordinator copies that session's ended turns from its own records, in start order: each recorded request (without start-point text), and the final text result or the ended status. Meeting answers and unfinished runs are not turns. The copy stays within the artifact cap: oldest turns go first, and the count of omitted turns is recorded. The copy is stored as the run's `session_conversation` record with provenance and a hash in `run.started`. Scheduled agents that receive the brief get it as text-only user/assistant messages; delegated, question, resumed, branched and meeting contexts do not. Explicit start points, explain runs and review-page feedback keep their start-point text.

## Conversation agent and final replies

A role with `answer: "final_reply"` is offered neither write_artifact nor submit_result; its instructions tell it to reply directly. When its execution ends normally, the worker names the last finished model reply that carried text and no tool call, and the Coordinator records that reply as the result version citing the model call, then submits it with its own host-authorized write_artifact/submit_result calls. Earlier tool use in the same execution does not prevent this; meetings still require an answer with no tool call. An empty, truncated, failed, cancelled or late reply submits nothing and the task fails as before. Only these Coordinator calls pass the role's write/submit permission checks.

Session chat starts the conversation definition: one lead "Assistant" (final reply, text output, session work tools, read_artifact, ask_user/update_plan, spawn_subagents/await_tasks). No chooser request runs. The `team` option decides who the lead may delegate to: `none` gives a general helper the lead calls only when the person explicitly asks for subagents or a team; `auto` gives the auto-team roster (planner, researcher, writer, reviewer); `{corralId}` gives that Corral's roles, with its graph passed to the lead as guidance only. Delegates answer with final replies, and their models are prepared with the run. A missing Corral is `TARGET_NOT_FOUND`. The explain endpoint runs one tool-less final-reply role.

In a linked, trusted folder a live session turn runs under the built-in `session-default` work style (trusted-native) unless the request names one; the person's and project's defaults layer over it and may restrict it. The lead, helper and writing roles then get `run_command` and the preview tools, each command under the permission mode; reviewers stay read-only, and a Corral role without its own style works in the session's. Simulated agents and untrusted folders get no work style. The work style's tool list does not block the Coordinator's own final-reply publication. A wait ended by the turn's cancellation settles as cancelled. A conversation start records its request hash, so a resend returns the recorded run and the start's cancellation reaches it.

A new version of an artifact the same execution already wrote since its last submission is not progress. After six model replies without new file evidence, artifact or review progress, every run, limited or not, waits for a `no_progress` approval before its next request.

Independent meeting replies begin from one published user snapshot in parallel. Mentions/reactions follow published messages sequentially. Each participant can continue a compatible successful checkpoint with newly posted messages, which are introduced as posted since its last reply; model/role changes or missing checkpoint fall back to full published context, introduced as the conversation so far. A started answer remains attached to its original user message. Secretary adoption and handoff still require their existing explicit commands.

Checkpoint v2 reuses immutable message and artifact bodies through a versioned manifest; v1 remains readable. Storage failure leaves the latest committed recovery point visible. Restart records unfinished operations as interrupted/unknown, without replaying network effects. Recovery/fork and private export validate referenced content hashes; public exports omit it.

Source closure follows owned finished tool records, not only toolResult messages still visible after compaction. The execution reuses successfully committed chunk/source references, while message snapshots and restored body hashes remain validated. Selecting one checkpoint does not hydrate every other checkpoint.

Usage reports retain reported/estimated/unknown provenance and nullable counts. Zero is not inferred from missing data. Subscription usage has no invented zero-dollar API price. Late usage completes the original attempt and its Run usage record without reviving tasks. History pages are bounded and do not load the whole ledger into Settings. The Settings screen that reads them is [설정의 모델 요청 이력](#설정의-모델-요청-이력).

Chooser usage in the Run derives from the existing attempt ledger: one `usage.recorded` per prepared physical request, with its reported usage or null when unknown. No payload prepared means no usage record. Late usage fills only the matching record; past snapshots and choice text are not rewritten. Callers without a managed ledger record only reported usage. The chooser prompt and visible-text gate share a 4,096-byte JSON bound; model output allowance and reasoning are separate from that byte bound.

Each physical chooser attempt has 30 seconds from provider SDK dispatch to completion. Admission and retry waits are excluded, including reacquiring a slot. User cancellation remains active while waiting and during transmission. The response timer ends with its attempt; retries use the same rule and the existing two-retry maximum.

[Port notices](../../THIRD-PARTY-NOTICES/llm-runtime-ports.md) describe pinned DSH MIT and PI LGPL sources, modifications, corresponding source distribution and rebuild/replacement steps.

## 설정의 모델 요청 이력

설정 → 모델 → **사용량** 탭을 선택하면 요청 이력의 첫 페이지를 읽는다. 호출은 `GET /api/v1/model-attempts`이고 `limit`은 50이다. 원장 전체를 읽지 않는다. 그 탭이 선택되기 전에는 읽지 않는다. 탭을 떠나갔다 다시 선택해도 저절로 다시 읽지 않는다. **새로고침**은 첫 페이지를 다시 읽고, **이전 요청 더 보기**는 다음 커서가 있을 때만 `before`로 다음 페이지를 이미 읽은 것 뒤에 붙인다.

읽은 페이지만 표 위에 차트로 보인다. 더 보기로 붙인 페이지도 같은 차트에 들어간다. 모델은 공급자와 모델 ID로 묶는다. 막대는 확인된 입력·출력·캐시 읽기 토큰의 합이다. 없는 값은 0으로 그리지 않는다. 한 계열이 모두 없으면 미확인 표시만 둔다. 일부만 없으면 확인된 합만 막대로 그리고, 빠진 수를 글과 미확인 표시로 남긴다. 확인된 0은 0으로 두어 미확인과 구분한다. 토큰이 미확인인 요청도 시간순 요청에는 넣는다. 시간 위치는 그 요청의 `startedAt`이다. 추론 토큰과 캐시 쓰기 토큰은 차트와 표에 보이지 않는다.

비용은 막대 길이로 그리지 않는다. 구독, 가격 미확인, 보고된 0, 추정된 0은 차트의 글에서 서로 다른 말로 센다. 읽은 페이지에 없는 구분은 0건으로 만들지 않는다. 표는 요청별 상세다. 구독, 가격 미확인, 추정 금액, 보고 금액은 표에서 서로 다르게 읽히고, 보고된 0은 보고된 0으로 남는다.

차트의 합계는 막대 옆 글로도 읽힌다. 계열은 무늬와 이름으로 구분하고 색만으로 구분하지 않는다. 차트는 움직이지 않으며, 동작 줄이기에서도 같은 값을 바로 보인다. 글자 크기는 인터페이스 밀도(기본 또는 compact)를 따른다.
