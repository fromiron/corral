# CR-053 Session Overview Widgets

## Scope

- Tracking: C-185 / CRL-UX-011 / TC-RAIL-001-H,N,F.
- Date: 2026-10-24 (Asia/Tokyo).
- Artifact: working-tree changes above `b30930f` (#101 merged into local main); no release verdict.
- Request: inventory the session's right side, keep the figures people want, show them as design-kit widgets that open their detail on click, and make the side panel less dense. The approved set is context, usage, results, changes, agents and environment. Bell then revised the placement twice ([CR-053](../change-requests/CR-053-session-overview-widgets.md)). First: on the right of the conversation view, not in the side area. Second: the conversation view stays as it is, and the widgets float at its right and stay put, not as a column that divides the area. In both revisions the widgets hide when the view is too narrow.
- Environment: Linux, Node 24.14.0, pnpm 10.30.3, headless Chromium (Playwright). The intermediate checks used a local `pnpm corral dev` server with saved sessions. The final check used the Vite in-memory demo with a simulated run, because a `corral dev` that Bell started held port 4317 and was left untouched. No model request was sent by these checks.

## Applied changes

- **Observed:** `ChatView` takes `aside` content, which the session conversation fills with `OverviewPanel`. It renders as an absolutely positioned layer inside the view, outside the scrolling timeline. The view's children and the centered conversation are unchanged. `index.css` makes `[data-chat-view]` a `chat-view` container. The widgets are as wide as the right margin allows (at most 18rem) and show at 75rem and wider when they have content. Below that, the composer's Overview button (`session-summary-trigger`) shows instead and opens the same widgets in a popover. This replaces the earlier rule, which measured the whole workbench at 900px.
- **Observed:** the intermediate two-column version, which wrapped the view in a frame and gave Overview a fixed 18rem column, is removed. The conversation no longer gives up width for the widgets.
- **Observed:** the first implementation's dock pane `overview` (registry entry, initial layout, one-time insertion into saved layouts, `Docking.overview` label) is removed. Its test went with it, and the files match `b30930f` again. A browser layout saved during that interim still names `context:overview` and shows it as an unavailable tab until it is closed.
- **Observed:** `OverviewWidgets` stacks compact kit Cards in a fixed order, each only when it has content. Without a run it renders nothing, which keeps the widgets hidden. Context, Usage, Agents and Environment are Popover triggers that open the existing detail views beside the widget. Results link to the Run pane. Changes opens the run's diff.
- **Observed:** the Results pane no longer repeats the summary card. `SessionWidgetCard` and its CSS are removed. The test IDs `session-summary-card`, `session-summary-trigger`, `session-summary-popup` and `context-usage-chip` are kept.
- **Observed:** the kit `CardTitle` stacks an invisible copy of its children in one grid cell. The widget title row therefore lives in a span inside it, as recorded in [DESIGN.md](../../DESIGN.md).

## Verification

| Check | Result and evidence | Boundary |
|---|---|---|
| Red tests first | **Measured:** the floating-layout `ChatView.test.tsx` cases failed against the two-column version. That version had a frame wrapper and no absolute, margin-sized rule. They passed after the change. The no-run case of `OverviewWidgets.test.tsx` failed while it still printed a message | jsdom cannot evaluate container queries; the CSS rules are checked as text |
| Focused units | **Measured: PASS**, `ChatView.test.tsx` 3, `OverviewWidgets.test.tsx` 4, `overview.test.ts` 5 | Mocked router; popovers in jsdom |
| `pnpm -r typecheck`, Biome errors | **Measured: PASS** | — |
| Studio `src/workbench`, SessionPage and MeetingPage | **Measured:** 344 passed, 3 failed. All 3 failed before this change (GitPanel, TerminalPanel, markdownAgentImport) | Not rerun at root. The earlier root `pnpm test` in this session had 10 failures: the design guard ×2 on verbatim kit files, RunPage.layout ×3, these 3, a `workbench-journey` run that passed on its own rerun, and the Storybook `Timeline` story that selects a native option from what is now a kit Select |
| Demo, 2560×1440, dark and light, side group open | **Measured:** chat view x 256–1636. Conversation content x 573–1309, the same as without the widgets. Widgets x 1336–1624, 27px clear of the conversation, with the same box after scrolling the timeline to the top. Trigger hidden; no horizontal scroll. **Observed:** Context, Usage (2,078 output tokens, 2 calls), Results and Environment (Simulated) cards float top right | Simulated run; no agents or working-copy changes |
| Demo, 1920×1080, side group open | **Measured:** chat view 996px wide. Widgets hidden, composer Overview button shown, no horizontal scroll | — |
| Earlier, local server | **Observed (two-column version):** the widget figures, the Usage and Context details, and the 390px button matched the saved run. The widget code is unchanged since | Placement checks above supersede this |

## Unknowns and rollback

Server-backed and demo Playwright specs were not run. `chat-widgets.spec.ts` expects `session-summary-card` to be visible. At its default 1280px viewport the widgets are hidden behind the composer button, so that spec probably needs to open the popover first. `chat-surface.spec.ts` expects the summary trigger at 760px. Other operating systems, screen readers and native IME were not checked. Agents, Environment and Changes widgets were verified only by unit tests.

To undo, revert the CR-053 source and tracking changes together.
