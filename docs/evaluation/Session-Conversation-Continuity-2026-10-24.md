# CR-054 Session Conversation Continuity

## Scope

- Tracking: C-186 / CRL-LLM-007 / TC-LLM-007-H,N,F.
- Date: 2026-10-24–25 (Asia/Tokyo).
- Artifact: working-tree changes above `30d4959` (PR #101 and CR-053 on local main); no release verdict.
- Request: re-review PR #101 after a chat follow-up ("하이") returned the previous answer. Then improve the CR, specification and contract documents as needed, and extend the PR's goals: usage accounting boundaries, cache hit rate, and session and meeting chat logic ([CR-054](../change-requests/CR-054-session-conversation-continuity.md)).
- Environment: Linux, Node 24.14.0, pnpm 10.30.3. Checks used the deterministic pi-ai faux provider, the in-process worker, the in-memory and SQLite stores, Studio unit tests, and the Vite in-browser demo in headless Chromium and the app's browser pane. The local database was read only (`mode=ro`). No model request was sent by these checks.

## Review evidence

- **Observed:** chat follow-ups are new Runs. The composer sent `startFrom` with the newest result, and the Coordinator appended that result under "Start from this earlier version" (CR-007, required by CR-011 §3). The earlier request itself was not sent. Since #101 the user message opens with assignment metadata, then the request line, then the earlier answer.
- **Measured (local DB, ChatGPT profile):** six turn requests in three Runs of one session. Within each Run, the system sections, tool declarations and cache namespace were identical, and every request reported 0 cached tokens. In the recorded #101 live comparison, the old main path hit in 3 of 30 runs and the new path in 0 of 30 (every run compacted). The chooser probe, which repeats an identical payload, hit in 28 of 30. No offline cause was found. `prompt_cache_key` and the session affinity options reach pi-ai unchanged.
- **Measured (local DB, Hive):** requests 1–2 s apart in one Run reported 0 cached tokens. The next Run's first request read 1,792 (system plus tools), and a meeting continuation read 13,824 of 15,546.
- **Measured:** each Run's spent output equals its turn outputs plus the settled chooser output, with no unknown outstanding. No accounting change was made.
- **Reference:** DeepSeek Harness 0.2.1-rc.2 (MIT, local npx cache, package READMEs and types only) appends per-step context after the reusable prefix. Corral adopts only that ordering idea. No code was copied, and `~/.dsh` (credentials, sessions) was not read.

## Applied changes

- **Contracts:** `ConversationSource`, `ConversationTurn`, `SessionConversation` and `ContinuedConversation`. Optional `conversation` on `StartRunRequest`, `CreateRunRequest`, `run.started` and `AgentStartInput`. Generated create-run and run-event schemas were regenerated.
- **Coordinator:** `sessionConversation` reads the session's ended turns through `throughRunId` from its own records. It removes CR-007 start text by recomputing it from the recorded source version, and drops the oldest turns or the newest answer to stay within `maxArtifactBytes`. It refuses a missing session, a missing, foreign or unended run with `TARGET_NOT_FOUND`. The copy is stored as `session_conversation`, with provenance and a hash in the snapshot and `run.started`. Only scheduled agents bound to the brief receive it. Resumed, branched, meeting, delegated and item executions do not. CR-007's text comes from one helper, so recording and removing it cannot drift apart.
- **History:** private export includes `session_conversation`. Opening an archive checks its schema and hash and that `run.started` matches the snapshot.
- **Workers:** the start frame carries the turns, and protocol versions are Core 8 and SDK 9. Core and SDK place text-only user/assistant turns before the assignment. The assignment says that earlier messages are prior requests and answers, and to revise only when asked. The synthetic assistant messages carry zero usage, which the context meter ignores.
- **Auto start, server, client:** `conversation` is forwarded like `startFrom`, so the auto request hash covers it.
- **Meeting:** a continuation introduces "Messages posted since your last reply:". A full-history answer keeps "Conversation so far:".
- **Studio:** the composer's `next` (team and auto) sends `conversation` with the newest ended run and no longer sends `startFrom`. Its hint reads "Continues this conversation". `explain` and review-page feedback keep their start point. The Usage detail adds input tokens, cached input with its share, and a count of calls without a cache report.

## Verification

| Check | Result and evidence | Boundary |
|---|---|---|
| Red tests first | **Measured:** the core CR-054 tests (6) failed with `SCHEMA_INVALID`, the worker test failed to start its Run, the meeting assertion failed, and 4 Studio usage checks failed. All failed before the implementation | — |
| Core | **Measured: PASS** `session-conversation.test.ts` 6, `meeting.test.ts` 31, plus `start-from-version`, `history` and `message-branch` | In-memory store with scripted agents |
| Worker | **Measured: PASS** request order system → turn user → turn assistant → assignment → state; the third follow-up's first request reads at least the long first answer more from the faux prefix cache than the second | Core worker only; the SDK worker shares the helper but has no dedicated test |
| Studio units | **Measured: PASS** `overview.test.ts` and `OverviewWidgets.test.tsx`, 12 | jsdom |
| `pnpm typecheck` | **Measured: PASS** | — |
| Biome on changed files | **Measured:** 0 errors. 15 new `noNonNullAssertion` warnings in the two new test files, matching existing test style | — |
| Full `pnpm test` | **Measured:** 2221 passed, 10 failed, 23 skipped. The 10 failures are the same tests that failed before this change in this session (design guard ×2, RunPage.layout ×3, GitPanel, TerminalPanel, markdownAgentImport, Storybook Timeline, `workbench-journey`). `workbench-journey` passed when rerun alone, with the focused suites (15 files, 134 tests) | Not a release gate |
| In-browser E2E `sessions.spec.ts` WBTST-004 | **Measured: PASS** 2/2 in Chromium. The follow-up hint, the follow-up Run, and the question still showing its start point | Updated assertion follows CR-054. The server E2E specs were not run |
| Demo, browser pane | **Observed:** after "피보나치 수열 설명해봐", the composer shows "이 대화를 이어 갑니다". The follow-up "하이" succeeded, and its simulated agent echoed a brief of only "하이", with no start-point text. No console errors | Simulated agents; no model quality evidence |

## Unknowns and rollback

The live check is not done. "피보나치 수열 설명해봐" followed by "하이" on ChatGPT and Hive still needs Bell's opt-in. So does a live payload probe for the ChatGPT subscription path's zero cache reads. Other operating systems, the SDK worker end to end, the server Playwright specs, and real cache hit rates after this change were not measured. Runs started before this change keep their CR-007 briefs. A session branched from a message carries only its own turns.

To undo, revert the CR-054 source, contract, schema and tracking changes together. Runs recorded with `conversation` remain readable only by builds that know the field.
