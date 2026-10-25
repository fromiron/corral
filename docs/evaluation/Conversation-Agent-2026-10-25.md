# CR-055 Conversation Agent, Team Selector and Turn Display

## Scope

- Tracking: C-187 / CRL-LLM-008 / TC-LLM-008-H,N,F; C-188 / CRL-UX-012 / TC-TURN-001-H,N,F; C-189 / CRL-LLM-009 / TC-TEAM-001-H,N,F; C-190 / CRL-LLM-010 / TC-TEAM-002-H,N,F.
- Date: 2026-10-25 (Asia/Tokyo).
- Artifact: working-tree changes above `30d4959` on local main, together with the uncommitted CR-054 work. Nothing is committed, and this is not a release verdict.
- Request: Bell asked for a root-level rework of chat, with DeepSeek Harness (DSH) as the reference ([CR-055](../change-requests/CR-055-conversation-agent-and-teams.md)). The amendment in §6 removes Ultra and the request options from the composer and puts Corral management in the team selector. The amendment in §7 gives session turns command and preview tools by default.
- Environment: Linux, Node 24.14.0, pnpm 10.30.3. Checks used scripted agents, the in-process worker with the deterministic faux provider, Studio unit tests in jsdom, the Vite browser demo (simulated agents) in the app's browser pane, and Playwright Chromium against the local server (`server` project) and the demo (`chromium` project). No model request was sent by these checks. The user's running `pnpm corral dev` server was not restarted and still serves the old build.

## Findings behind the change

- Automatic effort selection is not the cause of the two-request answers. The write_artifact → submit_result output contract is. Effort runs a local judge and sends no provider request. One "하이" in Auto mode cost a chooser request of 177 input tokens, then turn requests of 2,163 and 2,233 input tokens, with 0 cached tokens in each.
- The question-mode loop wrote the same artifact 36 times without submitting it. The explain call cap was not enforced, because CR-052 treats a definition with no budget as unlimited. Each rewrite counted as progress, and the no-progress warning did not stop the run.

## Applied changes

- **Final reply (C-187):** `AgentRole.answer: 'final_reply'`. Such a role is offered no write_artifact or submit_result and is told to reply directly. Both workers report the final reply's model call even after earlier tool use. The Coordinator's `submitFinalAnswer` publishes that reply through host-authorized calls. Only those calls pass the role's write/submit checks. Explain uses a tool-less final-reply role.
- **Progress guard (C-187):** a new version of an artifact that is already written but not submitted is not progress. After six replies without progress, every run, limited or not, waits for a `no_progress` approval.
- **Conversation agent and teams (C-189):**
  - Session chat starts one lead with no chooser request. `team: none` gives it a helper that it calls only when the person asks. `auto` gives the auto roster. `{corralId}` gives that Corral's roles, with the graph passed as guidance.
  - The roster's models are prepared with the run. A missing Corral is `TARGET_NOT_FOUND`.
  - The team is part of the composer's request identity.
- **Turn display (C-188):**
  - Each turn shows the message, one flat process group and the answer inline.
  - While running, the header reads "작업 중 · N초". When finished, it folds to "작업 N초 · M단계". The shimmer stops under reduced motion.
  - Raw replies are numbered by request.
  - Under the composer: turns · steps · tokens · cache hit, or "캐시 보고 없음" when no call reported cache. Output speed is not shown.
- **Composer (§6):**
  - The 후속 작업/질문 selector, the request-options popover, Ultra and `/ultra` are removed.
  - The team chip lists 팀 없음, then a Corral group: auto, each saved Corral, and Corral 만들기·관리.
  - The orphaned `AutoHarnessPicker` was deleted. `autoCommandSeed` now takes the team instead of scope and Ultra.
- **Default session tools (§7, C-190):**
  - A live session turn in a trusted folder binds the built-in `session-default` work style unless one is chosen; personal and project defaults layer over it. Writers get `run_command` and the preview tools; reviewers stay read-only. Simulated agents get no work style, because a simulated style refuses file tools.
  - The Coordinator's final-reply publication skips the work style's tool checks. A wait ended by cancellation settles as `cancelled`.
  - A conversation start records its request hash (`autoRequestHash`), so a resend returns the recorded run. The server's start-cancel route accepts conversation starts.
  - The scripted test agent no longer writes its own note after delegating, so a team's file changes come from its delegates.
- **Server E2E specs:** `auto-harness` and `project-document-error` are retired, and `auto-regressions` keeps only the No team and cancellation reconciliation tests. The others now drive the team chip and plain final replies, with no chooser request: `chat-first-composer`, `composer-controls`, `m1-interactions`, `project-materials`, `file-preview`, `service-preview`, `desktop-capabilities`, `workbench-identification`, `chat-widgets`, `contextual-settings`, `chat-entry` and `ux-review`. `alpha` and `files` now read the delegate's file (`notes/team_writer_role.md`). Where a team turn also shows "role · Succeeded" rows, the status matches are exact, and the demo's `#73` saved-team check runs the team from its editor.

## Verification

| Check | Result and evidence | Boundary |
|---|---|---|
| Red tests first | **Measured:** the final-reply, conversation-agent, turn-process and progress tests failed before their implementations. The request-identity test (`autoChoice.test.ts`) failed before `autoCommandSeed` took the team | — |
| Core and adapter | **Measured: PASS.** `conversation-agent.test.ts` 11, `final-reply.test.ts` 6, `unlimited-default.test.ts` | Scripted agents; faux provider for the worker |
| React and Studio units | **Measured: PASS.** `turn-process.test.ts` 3, `execution-transcript` 6, `RunMessage.density` 9, `overview` 7, `autoChoice` 6, `SessionPage.context` 3 (now expects the conversation start with `team: {corralId}`), `locales` 3 (`auto` allowed as the team's name) | jsdom |
| Server | **Measured: PASS.** `server.test.ts` 42 | In-process |
| §7 red tests | **Measured:** TC-TEAM-002-H/N/F, the cancelled wait (TC-TEAM-001-F), the resend (core) and the start-cancel route (`auto-cancel.test.ts`) each failed before their fixes. The mock-mode case failed while the session default was bound to simulated agents | — |
| Core, server units | **Measured:** core 510 passed. `harness.test.ts` 24 and `auto-cancel.test.ts` 12 passed. Server suite 617 of 618 passed. The one failure, `workbench-journey`, was already failing before this work, and it passed in a later run | In-process |
| `pnpm typecheck`, `pnpm contracts:check`, `pnpm spec:check` | **Measured: PASS.** Pack validation 3309 checks; 433 of 437 scenarios have tagged tests | Documentation checks are not product tests |
| Biome on changed files | **Measured:** 0 errors; warnings only, in the existing style | — |
| Full `pnpm test` | **Measured:** 2253 passed, 10 failed, 23 skipped. Nine failures were already failing before this work: design guard ×2, RunPage.layout ×3, GitPanel, TerminalPanel, markdownAgentImport and Storybook Timeline. `pty-session` failed under load and passed alone | Not a release gate |
| Server E2E (`--project=server`) | **Measured:** 93 passed, 35 failed, 3 skipped. The same 35 tests also fail on a clean checkout of `30d4959` run in the same environment, so none is a regression from this change. They are chat-widgets ×2, contextual-settings ×2, workbench-identification TC-UX-007-N ×2, usability ×3, harness-overrides, harness-resources ×2, layout #82, markdown-agent-import, model-imports, models ×7, projects, reasoning-scope ×2, results ×2, server ×4, settings-controls ×2, settings-scope and skill-quality. The run-owned preview tests are skipped without `CORRAL_BROWSER_EXECUTABLE` | Faux provider and scripted agents; the baseline run's causes were not investigated |
| Demo E2E (`--project=chromium`) | **Measured:** 52 passed and 13 failed in the full run. After the fixes, the three new failures (desktop-workbench DW-02/03, layout #72 and #73) pass. The remaining 10 also fail at `30d4959`: accessibility TC-UX-001-H, chat-surface ×3, layout #75 and #83, run-compare, studio ×3. `sessions.spec.ts` and layout #77 pass | Simulated agents |
| Browser demo | **Observed:** team none answers inline with no process group. Auto shows delegate rows and folds to "작업 6초 · 6단계". The team chip shows 팀 없음, then Corral: auto, Research team, Corral 만들기·관리. The manage item opens the project's Corral list. A turn with Research team ran its Researcher delegates and folded to "작업 6초 · 6단계" | Simulated agents; reduced motion not emulated |

## Not verified or open

- No live provider run. Token savings and cache hits on ChatGPT/Hive are not measured for the new path.
- The retired browser checks of auto choice, Ultra, review only and project-material attachment (`auto-harness`, `project-document-error`, part of `auto-regressions` incl. TC-ABS-006 and TC-AUTO-002/005-N) have no browser replacement, because the composer no longer offers them. TC-ABS-006 stays covered by server tests. Ultra still exists in core, CLI, meetings and contracts.
- The 35 server and 10 demo E2E failures that also fail at `30d4959` are not explained here.
- The run page of a session turn with a saved Corral shows "composed for this run" and has no edit link to that Corral.
- Per-run role and style overrides no longer apply to Corral sessions. Session turns carry text-only history (CR-054), not full tool transcripts.
- Other OSes, screen readers and real IME are not checked.
