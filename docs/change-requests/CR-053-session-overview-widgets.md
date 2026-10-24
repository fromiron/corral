# CR-053 — Session Overview Widgets

- Approval: Bell, 2026-10-24 (Asia/Tokyo), asked to identify what the right side of the session shows, decide what is needed and what is not, turn the information people want into widgets built from the design kit, and open details on click, so the side panel stops being dense without hiding needed data. Bell approved the proposed set: context, usage, results, changes, agents and environment.
- Revision: Bell, 2026-10-24, after seeing the first implementation: Overview belongs on the right of the conversation view itself, as in the attached reference, not as a tab of the side area. After the second: the conversation view must stay as it is, with the widgets floating at its right and staying in place, not a separate column that divides the area; they hide when the view is too narrow.
- Tracking: C-185 / CRL-UX-011 / TC-RAIL-001-H,N,F.
- Status: approved; revised scope 1 and 5 implemented. Verification scope: [evaluation record](../evaluation/Session-Overview-Widgets-2026-10-24.md).

## Findings

The side area opens Files, Changes, Results and Run. The few figures people check about a turn (context use, output tokens against the limit, model calls, cost, results, changed lines) are spread over the Results pane's summary card and four nested folds of the Run pane, mixed with audit detail: prompt section hashes and sizes, configuration version, runtime defaults, authentication notes and per-result run identifiers. The Results pane also lists the same results twice.

## Scope

1. **Overview widgets float beside the conversation.** The conversation view keeps its own layout: the centered conversation, the composer and their widths do not change. Overview widgets float in the empty margin to the right of the centered conversation, from the top of the view, and stay in place while the conversation scrolls. They do not split the view into columns, and they do not depend on what the side area shows. They appear only when that margin can hold them (a conversation view at least 75rem wide) and a run is presented; otherwise they are hidden and the composer's Overview button opens them (scope 5). This replaces the earlier rule that the summary never adds a third column while a side pane is open. *(Revised twice: the first implementation added a dock pane `overview`, and the second split the conversation view into two columns; both are removed. A saved layout that still names the `overview` pane shows that tab as unavailable until it is closed.)*
2. **Widgets show what a turn did.** Overview stacks kit Card widgets for the presented run (the session's active run, else its last run), in this order, each shown only when it has something to say:
   - **Context** — use as a percentage with used and window tokens, or the message estimate, and a segmented bar of the measured categories. Unmeasured context says so instead of showing zero.
   - **Usage** — output tokens used, model calls against their limit, a small bar chart of output tokens per finished model call, the list-price estimate or why there is none, and unconfirmed usage still held against the budget. A run without usage limits shows what was used, without a limit.
   - **Results** — the run's results, newest first.
   - **Changes** — added and removed lines and files of the run's working-copy changes, only when a working copy applies.
   - **Agents** — working, waiting and failed agents, only for multi-agent or delegated work or when one waits or failed.
   - **Environment** — one line, only when the run differs from an ordinary local run (simulated or restricted).
3. **A click opens the detail in place.** Context, Usage, Agents and Environment open their existing detail view (ContextInspector, budget and per-request usage, agent states and plan choice, environment) in a popover anchored to the widget. A result opens in the Run pane; Changes opens the run's diff. Opening a detail never changes the presented run or the next request's settings.
4. **Audit detail stays where it is.** Hashes, sizes, configuration versions, runtime defaults and connection notes remain in the Run pane's folds and on the full run page. Nothing is deleted. The Results pane no longer repeats the summary card above its own list.
5. **The same widgets when the margin is too narrow.** Below 75rem the widgets are hidden and the composer's Overview button opens the same widgets in a popover.

Widget data comes from the presented run's existing store and reads; this adds no stream, poll or model call. The figures follow the chat widget contract's numeric invariants. This change refines CR-041's summary card placement; it does not alter Run control, Reins, approvals, budgets, saved data or permissions.

## Verification

Unit tests for the widget figures (normal, no limits, unknown usage, unmeasured context, hidden widgets) and for the rail and its details, confirmed failing before implementation. A structural test that the widgets float inside the conversation view without changing its layout or entering the scrolling timeline. Browser checks that the conversation keeps its position, that the widgets stay put while it scrolls, and the narrow popover. Inspect the session at desktop width in both themes and at 390px, and on the local server with a live run's saved layout.
