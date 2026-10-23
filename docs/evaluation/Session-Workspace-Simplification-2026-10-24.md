# CR-051 Session Workspace Simplification

## Scope

- Tracking: C-178 / CRL-UX-010 / TC-SWS-001-H,N.
- Date: 2026-10-24 (Asia/Tokyo).
- Artifact: the working-tree changes above `806dfe8ea9957a45490df17d360891c617536082`; no release verdict.
- Request: finish the screens not yet moved to the design kit, unify the design language on the kit, and simplify the session screen, especially the side panel and the path from the conversation into it. See [CR-051](../change-requests/CR-051-session-workspace-simplification.md).
- Environment: Linux, Chromium 1243 from `/opt/pw-browsers`, Vite 8.3.4 dev server for the browser demo (Node 22.22.0), Node 24.19.0 for the local-server E2E project, no paid model calls.

## Findings and applied changes

- **Observed before:** a new session showed a dock toolbar row (layout select, open-pane select and a native `<details>` with 12 arrange controls), three areas and ten tabs (Files, Changes, Git, Debugger, Results, Run; Checks, Problems, Terminal, Tasks & preview), several of them empty or server-only in the demo. A "Conversation detail" select took a row above the messages. A finished run showed its status three times (run card, status pill, and an "Elapsed 0s · Work record" line inside the composer), each linking to the Run pane under a different label.
- **Applied:** the toolbar row is gone on wider screens; each area header has an open-pane menu, a pane-actions menu (layout, move to area, size, split, previous/next pane, save rule) and close. Panes open in their own area from every entry point, and an area that is not open is recreated instead of covering the conversation. A new layout opens the conversation (larger share) with Files, Changes, Results and Run; presets add the panes they are for. Density moved to the session and meeting page menus. The activity line shows only for live work or a message; side-panel links share one mark. The Results pane lists results as compact rows instead of a card per result and no longer repeats them in its summary card.
- **Applied, kit migration:** the schedule page, review screen controls, run page tabs and buttons, image profile form, LSP proposal file picker, demo template picker, settings list rows, Git and task rows, debug frames, problem rows, error view and command palette close use kit Button, Select, Input, Textarea and Switch. Native disclosures take the kit Accordion trigger's look from `theme.css`. Chip selects are compact and hug their value. `ghost-muted`/`outline`/`xs` Button aliases in the touched components were replaced with canonical names.

## Verification

| Check | Result | Boundary |
|---|---|---|
| Studio and React typecheck, Biome | **Measured: PASS** (no errors; existing warnings unchanged in kind) | Static checks |
| Studio + React unit tests | **Measured:** 565 passed, 8 failed. The same 8 fail on `806dfe8` (design guard on copied kit source, RunPage layout ×3, GitPanel, TerminalPanel, Markdown agent import). TC-WBD-007-F, failing on `806dfe8`, now passes against the density menu | jsdom |
| New scenarios fail first | **Measured:** TC-SWS-001-H and TC-SWS-001-N fail on the previous source with the updated spec and pass on the change | Browser demo |
| Browser demo E2E (chromium project, 64 tests) | **Measured:** 51–53 passed. All remaining failures also fail on `806dfe8` (accessibility keyboard flow, chat-surface ×3, layout #75 and #83, run-compare, studio canvas ×2 and editor axe). Three tests that failed only while the server suite ran concurrently (demo TC-DEV-005-H, layout #74, sessions WBTST-004) passed when rerun alone | Local demo; timing under load is not a flake verdict |
| Server E2E (141 tests, Node 24.19.0) | **Measured:** full run with 4 workers while the demo suite also ran: 76 passed, 62 failed, 3 skipped. 41 of the failing tests also fail on `806dfe8` built and run the same way. Of the rest, 15 passed when rerun with 2 workers; three Git flows (TC-WBD-012-H ×2, TC-WBD-012-N/F) failed because the shared `panelTab` helper clicked a Git tab that a new layout no longer opens, and passed after the helper opened it from an area menu; TC-SEC-002-H fails intermittently on both (3 of 4 on `806dfe8`, 2 of 3 on the change) on a `model-config/preview` 400 | The pre-existing server failures are not investigated here; no full server pass is claimed |
| Screenshots | **Observed:** session empty and finished states, open-pane and pane-actions menus, Run and Results panes, session menu density submenu, run page and schedules in light and dark at 1440×900, and the session at 390px | Visual review, not a full contrast audit |

Updated tests keep their scenario IDs and behavior: DockWorkbench unit tests reach preset, split and close through the area menus; layout E2E #95 and #71 open Git, Terminal and Checks before asserting tab selection and hiding; #90 is replaced by TC-SWS-001-H,N; #91 checks the review scope options through the kit Select; the image profile server flow chooses its profile through the kit Select; the shared `panelTab` helper opens a pane from an area menu when the layout does not show it.

## Unknowns

Other operating systems, installed desktop builds, native IME and screen readers are not verified here. Saved dock layouts from before this change restore unchanged, so existing users keep their previous panes until they choose a preset.
