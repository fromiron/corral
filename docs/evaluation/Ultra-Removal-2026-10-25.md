# CR-056 Ultra Removal

## Scope

- Tracking: C-191 / CRL-ULTRA-005 / TC-ULTRA-005-H,N,F.
- Date: 2026-10-25–26 (Asia/Tokyo).
- Artifact: working-tree changes above `90cfa39` on branch `feature/agitated-khayyam-be6aa8`. Nothing is committed, and this is not a release verdict.
- Request: Bell said Ultra is a removed feature and may be stripped out entirely ([CR-056](../change-requests/CR-056-ultra-removal.md)). For old records, Bell chose to drop support entirely rather than keep them readable (2026-10-25).
- Environment: Linux, Node 24.14.0, pnpm 10.30.3. Checks used scripted agents, in-memory and SQLite stores, Studio unit tests in jsdom, a local server with the production Studio build in the app's browser pane, and Playwright Chromium against the local server (`server` project). No model request was sent.

## Applied changes

- **Contracts:** `qualityPreset`, `ultra`, the Ultra selection and team snapshot, the candidate views, the `select_candidate` / `cancel_candidate` commands, the `candidate.comparison_changed` event (also dropped from `contracts/event-catalog.json`) and `execution.created.candidateId` are removed. There is no legacy reader. `AgentStartInput` lost `candidateId` and `candidateComparison`; `CheckExecution` lost `expectedTree`. The generated JSON Schemas were regenerated.
- **Core:** `ultra-team.ts`, `candidate-team.ts`, `candidate-budget.ts` and `judge-context.ts` are deleted, as are the Coordinator's tournament, candidate, judge, refinement and promotion paths, the projection's candidate comparison and the auto team's Ultra template. "Request again" on a run whose snapshot names Ultra is refused with `CAPABILITY_DENIED`. New session entries cannot name Ultra. The provider cache key keeps `candidate: null`, so keys for existing sessions do not change.
- **Server:** the Ultra request fields, pool resolution and the `/runs/:id/candidates…` routes are removed. At start-up the server collects the runs whose snapshot `autoRoute` names `qualityPreset` or `ultra`. Every `/api/v1/runs/:runId…` route refuses them with `TARGET_NOT_FOUND` and "This run used Ultra, which was removed; it cannot be opened." A saved meeting handoff that recorded Ultra is refused when started or re-dispatched and marked refused. `candidate-workspaces.ts` is replaced by `legacy-candidate-copies.ts`, which only removes candidate copies left for a session when that session's working copy is removed. File edits made in a candidate's own copy no longer count toward the session copy's managed paths.
- **Client, CLI and Studio:** the client's candidate methods and Ultra types, the CLI's `--ultra`, `--ultra-models` and `--ultra-verifier`, the candidate comparison view, `UltraModels`, the meeting handoff's quality choice, the Ultra labels on entries and receipts, and the Ultra and Candidates locale keys are removed. The session's results panel skips runs the server reports as not found, instead of failing as a whole.
- **Tests:** the Ultra, tournament, candidate and live Ultra tests are deleted with their code. The reasoning conformance tests that only carried Ultra tags are renamed (`reasoning-providers`, `reasoning-anthropic`) and retagged TC-RSN-001. New tests: `packages/core/test/ultra-removal.test.ts` and `apps/server/test/ultra-removal.test.ts`. They use a fixture of a version 2 tournament and an unfinished version 1 comparison, with events and saved projections written by the pre-removal code. TC-ULTRA-005 cases were also added to the CLI, `MeetingHandoff` and `sessionDraft` tests.
- **Tracking and docs:** C-113, C-114, C-118 and C-173 are `removed` (by C-191). CRL-ULTRA-001–004 are marked removed, and CRL-ULTRA-005 is added. Current docs, the API contract, the model guide, the status table, the plans index and ADR-035 now say Ultra is removed and old Ultra Runs do not open; the Ultra plan is deleted. CR-031, CR-048 and CR-055 §6 carry pointers to CR-056. Historical evaluation records are unchanged, except one link to the deleted `judge-context.ts` in `llm-modernization/locations.md`, which is now pinned to `90cfa39` as plain text.

## Verification

| Check | Result and evidence | Boundary |
|---|---|---|
| Red tests first | **Measured:** with the new core and server tests and the fixture copied onto a clean `90cfa39` checkout, all 8 failed. Before the Studio fix, the browser check below showed the session's results panel failing ("이 결과를 읽지 못했습니다") | — |
| New and touched tests | **Measured: PASS.** core and server `ultra-removal`, CLI, `MeetingHandoff`, `sessionDraft` and server `files` (96 tests in these six files); contracts 36 | Scripted agents, in-memory and SQLite stores |
| Store with Ultra runs, in the browser | **Observed:** a scratch workspace seeded with the fixture runs, attached to a session, started normally. The project page listed the session. In the session, both Ultra turns showed "This run used Ultra, which was removed; it cannot be opened.", and the unfinished one showed as interrupted. The composer stayed usable, the run view showed Studio's usual missing-run text, and the results panel showed "아직 결과가 없습니다". The console had only the expected 404s and no page errors | Production Studio build, simulated agents; one session; Korean UI shows the server's English message |
| `pnpm typecheck`, `pnpm contracts:check`, `pnpm spec:check` | **Measured: PASS.** Pack validation 3046 checks; 426 of 440 scenarios have tagged tests (the old TC-ULTRA-001–004 scenarios lost their deleted tests) | Documentation checks are not product tests |
| Biome on changed files | **Measured:** 0 errors; warnings only, in the existing style | — |
| Full `pnpm test` | **Measured:** 2208 passed, 11 failed, 23 skipped. The contracts event-catalog failure among them was fixed afterwards (contracts 36 of 36 pass). The other 10 also fail on `90cfa39`: workbench-journey TC-WBD-025, Storybook Timeline, studio design ×2, RunPage.layout ×3, GitPanel TC-WBD-008-H, TerminalPanel TC-WBD-004-N, markdownAgentImport | Not a release gate |
| Server E2E (`--project=server`) | **Measured:** 93 passed, 35 failed, 3 skipped. The specs holding those 35 failures were rerun on a clean `90cfa39` checkout built in the same environment: all 35 fail there too (36 failed and 34 passed; `workbench-identification` TC-UX-007-H in light failed on main only), so none is a regression from this change. They are chat-widgets ×2, contextual-settings ×2, workbench-identification TC-UX-007-N ×2, usability ×3, harness-overrides, harness-resources ×2, layout #82, markdown-agent-import, model-imports, models ×7, projects, reasoning-scope ×2, results ×2, server ×4, settings-controls ×2, settings-scope and skill-quality, the same set the CR-055 record lists | Scripted agents and faux provider; the causes of the baseline failures were not investigated |

## Not verified or open

- No real user store from an earlier release was opened; old-store behaviour is checked with the captured fixture.
- A third-party API client that once sent `qualityPreset: "default"` would have recorded a non-Ultra run that is now treated as an Ultra run and refused. No Corral client sent that value.
- The Ultra-removed message is English inside the Korean UI.
- The host-isolated check runner (VerificationRunner with bwrap and the per-run tree isolation) stays, though no product path now asks for an isolated candidate check. Whether to remove it is open.
- Other OSes and the Electron app are not checked.
