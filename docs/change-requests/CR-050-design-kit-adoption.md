# CR-050 — Design Kit Adoption

- Approval: Bell, 2026-10-23, explicitly requested copying the design kit from `/home/bell/Toys/design_kit/` into Corral, then using `design-workflow` to normalize the tokens and update the English root `DESIGN.md`. Follow-up instructions require actual kit components and their composition throughout Corral, including `packages/react/src/components/`.
- Tracking: C-177 / CRL-UX-009 / TC-DKIT-001-H,N.
- Status: implemented; focused Linux verification completed on 2026-10-24. See the [adoption record](../evaluation/Design-Kit-Adoption-2026-10-23.md) for outcomes and unverified environments.

## Scope

1. Copy the kit's token definitions and applicable components into Corral. Use a kit component directly first, compose kit components when one does not cover the task, and write custom UI only when neither works. This order applies to `packages/react/src/components/`, Studio, and both sidebars. Preserve required behavior, data, and accessibility; legacy visual appearance is not a compatibility requirement. Keep copied source provenance with the adopted files; Corral must build without access to the source project.
2. Map existing semantic tokens to the adopted palette, type, spacing, radii, surfaces, and interaction states. Normalize remaining visual values after adoption and document the implemented system in [DESIGN.md](../../DESIGN.md), including YAML frontmatter and component usage guidance.
3. Preserve light/dark themes, keyboard operation, accessible control names, focus, errors, disabled states, and reduced-motion behavior. Remove redundant explanatory labels only when the control remains understandable and named.

Bell's follow-up requires the main and settings sidebars to use the kit's actual Sidebar components, not styling alone. The copied `design-kit/index` is the canonical component entry; existing shared `ui` imports may remain as a thin compatibility facade. Domain views use the kit's Accordion, Table, ChatMessage, InputGroup, Radio, Checkbox, Switch, Sidebar, and other applicable primitives rather than retaining custom controls or old card layouts for visual parity. Import only the necessary component/Motion dependencies. Corral pins the kit's required `motion@^14.1.0` range to stable `14.1.0`; rationale, compatibility, license, cost, and focused advisory evidence are in the [Motion notice](../../THIRD-PARTY-NOTICES/motion.md). Build output records the actual browser bundle impact.

The existing Base UI dependency moves from 1.4.1 to exact 1.9.0 to meet the kit's `^1.9.0` requirement and Select/Dropdown close APIs. Ordinary Dialog and Select use the actual kit compositions. This upgrade and the Motion addition are the dependency changes; the [Base UI notice](../../THIRD-PARTY-NOTICES/base-ui.md) records API, optional-peer, license, and advisory evidence.

The adopted visual system supersedes conflicting visual values in CR-039, CR-044, CR-045, and CR-047. Their interaction and accessibility contracts remain in force. This change does not alter settings lifetime, composer drafts, navigation targets, D&D, Reins, execution permissions, or stored user data.

## Verification

Use the existing browser demo and a small regression covering computed theme values and representative shared controls, plus the affected existing interaction checks. Confirm the new token expectation fails before implementation. Inspect the current UI at desktop and narrow widths in both themes. Keep behavior tests; remove only demonstrably redundant assertions that duplicate the same visual rule, retaining requirement and scenario IDs. Do not add speculative race or security work, repeat unrelated release gates, or treat local browser checks as full platform qualification.

Implementation state belongs in [backlog](../../contracts/backlog.json); executed checks and their environment belong in the [adoption record](../evaluation/Design-Kit-Adoption-2026-10-23.md).
