# CR-056 — Ultra Removal

- Approval: Bell, 2026-10-25 (Asia/Tokyo). After [CR-055](CR-055-conversation-agent-and-teams.md) §6 removed Ultra from the composer, Bell said Ultra is a removed feature and may be stripped out entirely ("싹 걷어내도 됨"). This CR removes it from the whole product: core, server, client, CLI, meetings and Studio.
- Tracking: C-191 / CRL-ULTRA-005 / TC-ULTRA-005-H,N,F.
- Status: approved; implementation and validation are recorded in the [evaluation record](../evaluation/Ultra-Removal-2026-10-25.md).
- Old records: Bell, 2026-10-25, chose to drop support for old Ultra records entirely ("옛 기록 지원 중단") over keeping them readable. §2 follows that choice.
- Supersedes: [CR-031](CR-031-ultra-quality.md) (C-113 Ultra preset, C-114 candidate comparison, C-118 multi-model Ultra) and [CR-048](CR-048-ultra-candidate-tournament.md) (C-173 candidate tournament), product-wide. Replaces the last two sentences of CR-055 §6 ("Server APIs for these options are unchanged for other clients; meetings keep their Ultra handoff") for Ultra only; the other request options keep their server APIs. Older CRs are cited for the history of the feature only.

## What Ultra was

`qualityPreset: "ultra"` on an auto start ran a fixed planner → writer → reviewer team with extra review rounds (C-113). `ultra` (selection version 1) fixed a pool of 2–5 models, each at its highest verified reasoning, plus a verifier (C-118), and optionally `comparison` candidates in isolated copies that a person chose between (C-114). Version 2 ran a candidate tournament: an anonymous judge, refinement rounds on the winner and automatic application, with no usage limits (C-173). It reached the HTTP API, the client, the CLI (`--ultra`, `--ultra-models`, `--ultra-verifier`), meeting handoffs and, until CR-055, the composer.

## Contract

### 1. No new Ultra work
1. Start requests no longer accept `qualityPreset` or `ultra`: auto starts (`POST /api/v1/runs/auto`), session messages, explicit start requests carrying an `autoRoute`, and meeting handoff executions. They are refused as invalid requests and nothing starts.
2. The CLI drops `--ultra`, `--ultra-models` and `--ultra-verifier`. Passing one is an unknown-option error.
3. The `select_candidate` and `cancel_candidate` Run commands, the `/runs/:id/candidates…` routes, the client methods for them and the candidate comparison view are removed.
4. The Coordinator no longer resolves Ultra pools, builds candidate or judge nodes, prepares candidate copies, runs tournaments or refinement rounds, or applies a winner. Auto teams have no Ultra template.

### 2. Old Ultra records are no longer read
1. The Ultra shapes are removed from every schema: `autoRoute.qualityPreset` and `autoRoute.ultra`, the `candidate.comparison_changed` event and `execution.created.candidateId`. Nothing keeps a legacy reader for them.
2. A store that holds Ultra Runs still opens. A Run counts as an Ultra Run when its snapshot's `autoRoute` names `qualityPreset` or `ultra`; the server finds them once at start-up, since no new one can start.
3. Every `/api/v1/runs/:runId…` route refuses an Ultra Run with `TARGET_NOT_FOUND` and the message "This run used Ultra, which was removed; it cannot be opened." Clients never receive its snapshot or events, so nothing tries to parse them. Run lists and session timelines still name the Run; Studio shows that message in place of the turn and leaves the Run out of the session's results.
4. Like every unfinished Run, an unfinished Ultra Run is interrupted when the backend restarts, so it does not hold its session. "Request again" on an Ultra Run is refused, and so is exporting it, like every other run route.
5. Session entries load as before; any Ultra choice saved on them is ignored. A meeting handoff saved with an Ultra choice is listed, but starting or re-dispatching it is refused with a message that Ultra was removed and starts nothing.
6. Stored data is not rewritten or deleted. Candidate copies and the `candidate_worktrees` / `candidate_executions` tables stay with their migrations. File edits made in a candidate's own copy never count as edits to the session copy. Removing a session's working copy still removes the candidate copies left for that session, so none stays registered in the person's repository.

### 3. Unchanged
Unlimited-by-default execution ([CR-052](CR-052-llm-runtime-modernization.md)), `usageLimits: "none"`, recipe checks and their candidate versions, maximum-reasoning metadata on model profiles, the auto team roster of CR-055 §5 and meeting handoffs to auto or a Corral are not part of Ultra and stay.

## Not in scope
Rewriting or deleting stored data, showing old Ultra Runs again, rewriting historical evidence records, and live provider runs.
