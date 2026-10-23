# CR-051 — Session Workspace Simplification

- Approval: Bell, 2026-10-24 (Asia/Tokyo), asked to finish the parts of the UI not yet moved to the design kit, unify the design language on the kit, and reduce the design complexity and usability problems of the session screen. The request names the side panel as the hardest part to use, the path from the conversation into the side panel as hard to follow, and asks for a combined review of layout and of why each element exists, the conversation included.
- Tracking: C-178 / CRL-UX-010 / TC-SWS-001-H,N.
- Status: implemented; focused Linux verification on 2026-10-24. See the [verification record](../evaluation/Session-Workspace-Simplification-2026-10-24.md).

## Scope

1. **Dock controls live in the areas they act on.** The separate dock toolbar row (layout select, open-pane select and a folded arrange section) is removed on wider screens. Each area's header carries an open-pane menu, a pane-actions menu (layout preset, move to area, size, split document, previous/next pane and the save rule) and the close action for its active pane. Every keyboard arrangement operation stays reachable through these menus. The narrow pane switcher and its return to the conversation are unchanged.
2. **A pane opens in its own area.** The open-pane menu, palette, `/` and URL use one placement rule: the conversation in the main area, terminal, tasks and checks in the bottom area, other panes in the side area. An area that is not open is recreated (within the existing four-area limit) instead of placing the pane over the conversation.
3. **A new layout starts with the panes the conversation links to.** A project without a saved layout shows the conversation beside Files, Changes, Results and Run, with the conversation taking the larger share. Other panes open on demand. A preset adds the panes it is for: Implementation adds Files, Terminal and Problems; Review adds Changes and Checks. Saved layouts, document references and the 20-document limit are unchanged.
4. **The conversation starts at its first message.** The display density preference moves from a header row above the messages to the session and meeting page menus. Its values and storage are unchanged.
5. **One status line per state.** The progress line above the input is shown while a run is live or has something to say. A finished run keeps its status pill, which links to the same record. Links that open the side panel carry the same panel mark.
6. **The rest of the visible UI uses the kit.** Remaining native selects, inputs, checkboxes and styled buttons on the session, review, run, schedule and image profile screens use kit Select, Input, Textarea, Switch and Button. Native `<details>` disclosures keep their semantics and take the kit Accordion trigger's look from the shared theme. Chip selects use compact kit sizing and hug their value.

This change does not alter Run control, Reins, approvals, document close decisions, saved data, permissions or the settings modal lifetime. CR-046 P10's dock contract is refined only in where its controls appear and which panes a new layout opens with.

## Verification

Run the affected unit tests and the browser demo layout, desktop-workbench and design-kit checks, and the server schedule and image-profile flows. Confirm both new scenarios fail on the previous UI. Inspect the session at desktop width in both themes and at 390px. Keep behavior assertions; where a test located a removed control, assert the same behavior through its new location.
