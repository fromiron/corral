# CR-054 — Session Conversation Continuity and Request Prefix Review

- Approval: Bell, 2026-10-24 (Asia/Tokyo). After PR #101 (CR-052) merged, a chat follow-up returned the previous answer again: "피보나치 수열 설명해봐", then "하이", produced a second Fibonacci explanation. Bell asked for a re-review of PR #101. Bell also asked for improvements to the CR, specification and contract documents where the bug calls for them, and for further work on the PR's own goals: usage accounting boundaries, cache hit rate, and the chat logic of sessions and meeting rooms. Bell permitted using pi-family harnesses (oh-my-pi, PI-Desktop, the locally installed DeepSeek Harness) as references for cache retention and chat-session handling.
- Tracking: C-186 / CRL-LLM-007 / TC-LLM-007-H,N,F.
- Status: approved; implementation and validation are recorded in the [evaluation record](../evaluation/Session-Conversation-Continuity-2026-10-24.md).
- Changes the contract of: [CR-011](CR-011-sessions-and-intents.md) §3 `next`, and the matching sentence of [CR-024](CR-024-session-auto-team.md) ("이전 결과가 있으면 CR-007대로 그 버전에서 시작한다"). Amends [CR-052](CR-052-llm-runtime-modernization.md) §5 and §7 as described below. [CR-007](CR-007-new-run-from-version.md) itself is unchanged.

## Review findings

1. **High — a chat follow-up is sent as "revise the earlier version".** CR-011 §3 starts every `next` request from the previous run's final result (CR-007). The Coordinator appends that whole result to the new brief under "Start from this earlier version", and the earlier request itself is not sent at all. Since PR #101 the user message opens with assignment metadata, then the one-line request, then the full earlier answer, and the system prompt no longer restates the brief. On both ChatGPT and Hive DeepSeek, short follow-ups ("하이", "오호") returned the earlier answer nearly verbatim. Before #101 the brief had the same structure, but no comparable greeting was recorded, so #101 is not proven to be the only cause. The root is the follow-up contract: chat turns are not delivered as a conversation.
2. **Medium — follow-ups share only system instructions and tools.** Each follow-up's first user message starts with that run's metadata, and the earlier answer comes after the new request. The longest prefix one follow-up can share with the previous one is therefore the system prompt plus tool declarations. Measured locally on Hive, a later run's first request read 1,792 cached tokens, which is that part.
3. **Medium, unresolved — ChatGPT subscription main-path requests report no cached input.** In the six local turn requests, consecutive requests of one run had identical system sections, identical tool declarations and the same `prompt_cache_key`, and every one reported 0 cached tokens. In the recorded live comparison, the old main path hit in 3 of 30 runs and the new path in 0 of 30 (each of those with a compaction). The chooser probe, which repeats an identical payload, hit in 28 of 30. No cause can be determined offline. A live payload probe needs Bell's opt-in, and this CR claims no fix.
4. **Low — Hive misses inside a run.** Requests 1–2 s apart in one run never hit; the next run's first request did. This is consistent with provider-side cache build latency, which is unverified. No change.
5. **Low — the meeting continuation header misstates its content.** A participant that continues its own checkpoint receives only the newly posted messages, still under "Conversation so far:".
6. **Low — cached input has no run total.** Reported cached input appears only per request: in Settings' model usage history, and for the latest request inside the Context detail's collapsed provider usage. The run's Usage detail does not total it, so the effect of a cache change on a turn is not visible where usage is read.
7. **No defect — usage settlement.** In local runs after #101, each run's spent output equals the sum of its turn calls and its chooser call, with no unknown outstanding. Chooser reservations follow CR-052's approved allowance rule. Nothing changes.

Reference (DeepSeek Harness 0.2.1-rc.2, MIT, read locally): per-step context is appended as a durable user message after the reusable request prefix, so "newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries". Session history is the event-sourced message log itself. Corral keeps its own Coordinator records as the source and adopts only the append-only ordering idea. No code is copied.

## Contract

1. **A session follow-up carries the conversation.** In a work session, `next` (including an auto session's request) sends `conversation: { throughRunId }`. `throughRunId` is the newest ended run the person saw. The request no longer adds CR-007's start point. The Coordinator, not the client, reads the turns from its own records:
   - **Turns:** the session's runs in start order, up to and including `throughRunId`, that have ended. Meeting answers and runs still in progress are not turns.
   - **Request:** the run's recorded brief, with CR-007's appended start-point text removed when the run had one. References stay as sent.
   - **Answer:** the text of the run's final result at its recorded version. A run without a text result contributes its request and its ended status only.
   - **Size:** the copied turns are limited to the installation's artifact cap (`maxArtifactBytes`). Whole turns are dropped from the oldest end, and the number dropped is recorded. When the newest turn alone exceeds the cap, its answer is replaced by an omission note.
   - **Refusal:** a `conversation` without `sessionId`, or a `throughRunId` that is missing, in another session or not ended, is refused with `TARGET_NOT_FOUND` and creates no run.
2. **The copy belongs to the new run.** The turns are stored as the run's own `session_conversation` record. `run.started` and the run snapshot record `conversation { throughRunId, turns: [{ runId, artifactVersionId | null }], omittedTurns, contextHash }`. Like CR-007, the new run never refers to another run's versions while it executes. Private history export includes the record and verifies its hash.
3. **Turns are messages, in a fixed order.** Every scheduled agent that receives the run's brief gets the turns. Delegated children, question responders, meetings and runs started from a resumed or branched context do not, because their context already carries their history. The model sees:
   - stable system instructions and tools;
   - each turn as a user message (the request) and an assistant message (the answer, or a short note that the request ended without one);
   - the current assignment;
   - the current Coordinator state.

   Turns carry text only: no earlier tool calls, permissions, IDs or images. The assignment message says that the earlier messages are this session's prior requests and answers, and that the model answers the current request and revises an earlier answer only when asked.
4. **The prefix grows only by appending.** The same turns are rendered identically in every later run, so a follow-up's prefix contains the previous follow-up's turns. Per-run metadata and state follow them. This amends CR-052 §5 ("stable instructions/tools/skills ahead of changing context") to include the conversation itself. The first follow-up still shares only the system and tool prefix with the first request, because the first request's user message was an assignment, not a turn.
5. **Explicit start points are unchanged.** These keep their behaviour and fields: "New run from this version" (CR-007), a question about a result (CR-011 `explain`), and review comments sent as a follow-up from the review page (CR-013), whose comments refer to that result. The composer's hint for `next` says the request continues the conversation; the `explain` hint still names the result it starts from.
6. **Meeting continuation names its content.** When a participant continues its own checkpoint, the new messages are introduced as messages posted since its last reply. A full-history answer keeps "Conversation so far:". This clarifies CR-052 §7. Order, parallelism and authority are unchanged.
7. **Usage shows cached input.** The Overview Usage detail adds input tokens and cached input with its share of input, counted only over finished calls that reported each figure. Calls that did not report cached input are named as unreported, never counted as zero. Spending, reservations and limits are unchanged.
8. **Worker protocol.** The start frame gains the optional turns. Both worker protocol versions advance (Core 8, SDK 9), so a worker from another build is refused instead of failing on an unknown field.

## Not in scope

No live provider probe without Bell's opt-in, and no fix claimed for finding 3. No change to provider cache keys, retention or headers, to budget settlement, or to the meeting order. Earlier runs, snapshots and events are not rewritten. Runs that already started from a CR-007 start point stay as recorded. In a branched session, history before the branch point stays only in the branch run's own context; follow-ups carry the branched session's own turns.

## Verification

Failing tests first, then the implementation:

- **Core:** a follow-up with `conversation` copies the earlier requests (without CR-007 text) and answers from the records, keeps the new brief exactly as typed, records provenance, and gives the turns to the brief's agents only. It also covers the omitted-turn cap, refusals, a duplicate command, and private export verification.
- **Worker:** the first provider request orders system, turns, assignment, state. A later follow-up's prefix contains the earlier turns, as shown by the deterministic provider's prefix-cache count.
- **Meeting:** continuation header.
- **Studio:** usage selector and detail with reported, partly reported and unreported cache figures. The composer's `next` sends `conversation` instead of `startFrom`.

Existing CR-007, CR-011, meeting and CR-052 regressions stay green. A live check of "피보나치 수열 설명해봐" then "하이" needs Bell's opt-in and is recorded separately.
