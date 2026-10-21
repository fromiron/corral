> **2026-10-20 실행 증거.** 아래 current/사용자 지시/브랜치는 당시 맥락이다. 현재 계약은 [채팅 위젯](../current/chat-widgets-contract.md), 현재 작업 범위는 [상태표](../status.md)를 따른다.

# Chat widgets: implementation and visual verification

Date: 2026-10-20 (Asia/Tokyo)

## Accepted target

The user supplied `Corral-Chat-Widgets-Implementation-Plan-v2.md`, then explicitly
corrected its top-bar interpretation: the supplied **Codex** screenshot places the
widgets in an independent upper-right card. This current instruction takes priority
over the earlier plan's top widget bar. The Todo remains immediately above the composer.

- Source visual: `C:/Users/Bell/AppData/Local/Temp/codex-clipboard-67d2865a-6c8c-47cc-8023-ec808646aec1.png`.
- Accepted plan copy: Git `373764467a52:docs/plans/Corral-Chat-Widgets-Implementation-Plan-v2.md`.
- Contract amendment and root causes: `docs/change-requests/CR-041-chat-widgets.md`.
- Branch/HEAD: `fix/studio-chat-display`, `ec5e244`, plus pre-existing and current uncommitted changes.
- Final static bundle inspected in the in-app browser: `index-BjEk4nTX.js`, `index-Ciqj0HpQ.css`.
  The only change after `index-DD5pA3iD.js` was the user's requested removal of the
  duplicated project/session breadcrumb while the desktop session sidebar is open.

## Visual evidence

All final captures below were made through the Codex **in-app browser**.

| Capture | State |
|---|---|
| `test-results/chat-widgets-iab/right-summary-final.png` | Right card; real Coordinator plan 2/7; question waiting |
| `test-results/chat-widgets-iab/right-summary-no-breadcrumb.png` | Final same layout after removing the duplicate top breadcrumb |
| `test-results/chat-widgets-iab/context-full-final.png` | Actual serialized request: 2,718 / 32,000 input tokens, about 8%; category breakdown |
| `test-results/chat-widgets-iab/summary-popup-final.png` | Detail panel replaces the right card; same summary remains accessible beside the composer |
| `test-results/chat-widgets-iab/completed-final.png` | Question answered and required approval accepted; result and 7/7 plan read back after browser reload |
| `test-results/chat-widgets-iab/context-partial.png` | Earlier faux-provider scenario correctly remains partial because no final payload was produced |

Source pixels are 2548×1396. Final full-view captures are 1598×1244. These are
different products and viewport sizes: this is an analogous responsive composition,
not a pixel-parity assertion. Both images were reopened together for the final
comparison. Native desktop window chrome is excluded from fidelity requirements.
Browser measurement of the final card: x=1282, y=108.67, width=300px, completed
height=372px. The reference's upper-right card is approximately 300px wide and
starts at y=109px.

The full-view comparison checks sidebar / conversation / upper-right companion
placement and bottom composer. The context-detail capture separately checks the
small labels, numerical hierarchy, color legend, ring and segmented bar.

## Comparison history

1. **P1 — wrong location:** original widgets were inside the scrolling transcript.
   The first correction moved them into an upper bar. The user identified that
   this still contradicted the Codex image.
   **Fixed:** upper bar removed; one shared data provider drives a 300px upper-right
   card and the composer. Existing details replace the card, without a fourth area.
2. **P1 — disappearing information:** narrow columns dropped widgets entirely.
   **Fixed:** below 900px of available Workbench width, or while details are open,
   “작업 현황” opens the same card in a keyboard-accessible popover.
3. **P1 — misleading measurement:** assembled request estimates could appear as
   complete before the final provider payload was measured.
   **Fixed:** assembled, final payload, legacy messages and partial/error states
   stay distinct. Actual Pi serialization and local HTTP delivery produced the
   complete snapshot used by the final screenshot.
4. **P1 — disconnected actions and duplicated activity:** a global DOM query could
   target another Run's response form; approval controls and active activity were
   duplicated in the transcript.
   **Fixed:** exact Run navigation opens the existing response host; active
   Pause/Resume and progress reside beside the composer, with scoped receipts.
5. **P2 — stale or inaccessible plan:** delayed body/hash validation, finished team
   owners, manual selection changes, hidden errors, and immutable archive caching
   could display the wrong state or never recover.
   **Fixed:** shared validated snapshots and explicit retries; request-scoped errors;
   in-flight read deduplication only; current execution ownership and manual choices
   retained.

## Fidelity review

- **Typography:** existing system font and Corral text scale retained. Small utility
  labels remain secondary; plan items and result content have a readable hierarchy.
  No additional font package or invented branding.
- **Spacing/layout:** the card is separate from the transcript, aligned near the
  top-right; the plan and input share one surface and alignment. There are no KPI
  grids or full-height summary panel borders. The existing detail panel remains
  resizable and replaces the summary.
- **Color/tokens:** existing dark neutral surfaces and muted text retained. Accent
  indicates measured occupancy or current plan state; warnings retain text and icons.
  Category swatches match the segmented bar. No new global visual theme.
- **Assets:** existing icon library reused. The Codex pet/avatar is not a Corral
  feature and was not copied or represented as a working capability.
- **Copy/content:** only recorded context, plans, tool states and results are shown.
  The local test result explicitly identifies itself as a deterministic response.
  No claim of real file changes or deployment is made.
  The duplicated top project/session path is removed when the desktop sidebar
  already presents that context. The session's accessible heading and utility
  controls remain; narrow/hidden-sidebar project switching is preserved.

## Real flow and authoritative readback

The final in-app sequence was:

1. Create a normal Auto session through the UI and send a multi-step request.
2. Actual Pi serializer sends HTTP to an isolated, keyless local endpoint.
3. `update_plan` passes through the Coordinator and private body storage.
4. The right card shows complete recorded input usage; the composer shows 2/7.
5. “요청으로 이동” opens that exact Run's existing question form.
6. Submit the answer, then accept the existing required criteria approval.
7. Actual result submission ends the Run; auto disclosure collapses at 7/7.
8. Reload the browser and read the persisted result, 7/7 state and final context
   back from the local server/SQLite.

Context details close with Escape and return focus to their trigger. The same is
true of the compact summary. The final page had no warning/error logs for the
final server URL. Earlier `Failed to fetch` entries belonged to intentionally
stopped prior QA servers, not the final build.

## Automated evidence

- Final widget server E2E: **4/4 passed** on `index-DD5pA3iD.js`.
  Actual serialized payload measurements, plan updates, manual/auto disclosure,
  current versus inspected Run, one SSE, draft/selection preservation, compact access.
- Right-card surface E2E: **4/4 passed**; right-of-transcript geometry,
  scroll/resize, result navigation, narrow panel activation, exact response focus.
- Previous integrated server cycle: **10/10 passed**, including the same four widget
  cases and six existing attachment/IME/question/steering/partial-result/history/
  approval regressions. The subsequent production change was the bounded Workbench
  narrow-navigation correction, covered by the surface suite.
- Focused combined unit/integration run: **153 passed, 2 existing opt-in skips**;
  separate real hook error regression: **3 passed**.
- Actual Pi HTTP process integration with added text-only complete-measurement cases:
  **10 passed, 2 existing skips**, covering core and SDK runtimes.
- Updated selector/design checks after removing unused top-bar-only helpers:
  **23 passed**.
- Studio, React and adapter TypeScript checks passed; scoped Biome error-level check
  and `git diff --check` passed.
- Contracts generation check passed. Spec check passed: **1,841 checks**,
  **261/261 scenario tags**. Windows validation used an isolated ignored Python
  environment with the repository's declared `jsonschema>=4,<5` dependency.

The faux provider deliberately does not invoke the final payload hook. Its
assembled-only display is not evidence of complete context measurement. The
separate actual-HTTP checks above cover that boundary without changing the UI
to conceal the limitation.

## Remaining verification limits

- No paid provider calls or autonomous live-LLM planning claim.
- IME regression uses composition events; native Korean/Japanese OS IME behavior
  has not been certified.
- No Electron packaging, production deployment, cross-browser certification or
  full screen-reader/WCAG conformance claim.
- Multi-agent ownership, manual selection, missing measurements, late revisions,
  cancellation and duplicate events have deterministic regression coverage; the
  final in-app screenshots use one active execution.
- Original screenshot and final app have different viewport sizes and content;
  exact pixel parity is neither requested nor claimed.

No actionable P0/P1/P2 visual mismatch remains within the corrected right-card
scope. Existing user changes were preserved; no commit, push or deployment was made.

final result: passed

## Follow-up: one-row session header

The user requested merging session tabs and panel/menu/search controls after
removing the redundant breadcrumb left an empty header row.

- Implemented one 52px header, reusing the existing controls and session-tab
  persistence. Removed the separate tab row. Tabs scroll horizontally within
  their available width; opening a session from another entry point reveals its
  active tab without moving keyboard focus. Desktop tab scrolling remains outside
  the window drag region.
- Measured in the in-app browser: conversation outlet previously began at
  y=84.67px; now y=52px. Tabs and all three controls are centered in the same row.
  No horizontal document overflow at the inspected 1364px viewport.
- Observed through the local server UI: created a session, sent the request,
  opened search, opened the session menu, opened/closed the detail panel,
  created a second session, switched back with its tab, and closed the other tab.
  Screenshot: `test-results/chat-widgets-iab/merged-session-toolbar.png`.
- Build `index-QsFHx_8F.js` / `index-DMppuZM1.css`, served by QA port 58639.
  Studio typecheck and scoped Biome passed. Final focused regressions: 5/5
  surface/narrow-sidebar checks, 1/1 settings/draft check, and 1/1 server
  tab/history check passed.
- The earlier broad desktop run also exposed two expectations: DW-02/03 assumed
  the composer was visible while the narrow work panel was selected; updated it
  to verify the selected panel, return through Conversation, and verify the
  original draft. DW-05 still expects “Link folder” where the pre-existing browser
  demo offers “Link the example folder”; this unrelated test selector failure is
  recorded without changing its test or product behavior.
- This is local browser verification; native Electron window dragging and OS
  window controls were not exercised.

## PR follow-up: folder-link test

Updated DW-05 to select the actual browser-demo button, “Link the example folder”.
The product behavior is unchanged. The combined desktop workbench, chat surface,
server widget and conversation-history suites passed **12/12**, including file
opening, line references, draft preservation, session tabs, narrow navigation,
plan updates, response routing and provider-payload measurement.

The broader Windows unit run returned 1,136 passed, 75 failed and 23 skipped.
Failures include POSIX permission/path assumptions, CRLF snapshot differences,
Windows temporary-file cleanup (EPERM), and process timeouts; this run is not a
full-suite pass. The React test type error (`exact` is not a Testing Library role
option) was fixed; the React typecheck and the affected test then passed.
Spec validation passed 1,855 checks / 261 scenario tags and generated schemas
matched their source. Hosted Linux CI is required before merge.
