---
name: review-components
description: Audits or defines reusable UI component and design-system contracts across design files, documentation, Storybook, source code, and live usage, covering anatomy, variants, states, content, responsive and accessibility behavior, semantic token mapping, design-code parity, affordances, action priority and visibility, grouping cues, and design-system adoption. Use when the question is how a component behaves or should behave. Not for consolidating visual values such as color, spacing, type, or radius tokens, and not for copying another design system's component specifications.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network.
metadata:
  author: leeskills contributors
  version: "0.7.0"
  languages: "en, ko, ja"
---

# Review Components

Treat a reusable component as a behavioral, content, interaction, and
implementation contract—not as a screenshot or a collection of visual variants.

## Delivery

For a review-only request, report each material issue's location, evidence,
smallest fix, and verification method; leave the artifact files unchanged.

For requested edits, follow **diagnosis → change plan → authorized patch →
final verification**. Include the actual diff or changed-file paths. A proposal
is not an applied fix. Report checks actually run and their outcomes, unverified
items, and how to undo your changes while preserving unrelated work.

Verify through the intended user flow where available and state environment
limits. Bundled report validators check declarations, not product behavior.
Re-run affected checks after any later edit. Keep the delivery proportionate to
the request; a small fix does not need a full report.

## Goal

Make components and shared systems predictable for users and maintainers across
design, documentation, code, responsive contexts, languages, input methods,
accessibility settings, and product adoption.

## Inputs

Use as available:

- component purpose and primary user task;
- project source of truth and ownership;
- design-library component and variants;
- documentation or Storybook;
- source code, tests, and rendered examples;
- representative product usage and decision contexts;
- project tokens, breakpoints, content rules, and action-priority rules;
- overflow menus, disclosure paths, and available-space evidence;
- supported browsers, devices, input methods, and accessibility baseline;
- for design-system work, current inventories, legacy-to-target mappings,
  adoption status, version history, roadmap, and deprecation criteria.

Record missing surfaces as `unknown`. Do not infer runtime behavior from a
design file or screenshot.

## Evidence states

Use exactly:

- `observed`
- `measured`
- `inferred`
- `unknown`

An observed visual state is not measured runtime support. Keep those statements
separate.

## Contract dimensions

Review the applicable dimensions:

1. **Purpose and selection** — when to use the component and when not to.
2. **Anatomy** — required, optional, and conditional parts.
3. **Variants and sizes** — distinct communication or task roles.
4. **States** — visual state, behavior, feedback, and accessible representation.
5. **Interaction** — keyboard, pointer, touch, focus, timing, and dismissal.
6. **Content** — labels, length, localization, truncation, overflow, and errors.
7. **Responsive behavior** — what changes and what information must remain.
8. **Tokens** — semantic color, type, spacing, radius, elevation, and icon roles.
9. **Composition** — nesting, adjacency, priority, and repeated-group behavior.
10. **Accessibility** — name, role, value, relationships, focus, status, and target.
11. **Ownership** — source of truth, change process, exceptions, and deprecation.
12. **Parity** — alignment among design, documentation, code, and live usage.
13. **Affordance mapping** — whether visual treatment matches expected and actual
    behavior, including justified exceptions.
14. **Action governance** — priority within each decision context, persistent or
    disclosed visibility, and the cost of hiding important actions.
15. **Grouping cues** — whether proximity, alignment, similarity, or a container
    communicates each relationship with the least unnecessary visual weight.
16. **System lifecycle** — inventory, governance, versioning, migration,
    coexistence, adoption, ownership, and removal gates when a design system is
    in scope.

Read [references/contract-rules.md](references/contract-rules.md) for the base
contract rules (ownership, selection, anatomy, states, content, responsive and
input behavior, semantic tokens, parity, and exceptions) before normalizing
another system's component guidance. Read the conditional references only when
their dimensions are in scope:

- [references/interaction-governance.md](references/interaction-governance.md)
  — dimensions 13–15: affordance mapping, action governance, or grouping cues;
- [references/system-lifecycle.md](references/system-lifecycle.md) —
  dimension 16: introducing, migrating, or adopting a shared design system.

## Procedure

1. Restate the component or system purpose, primary user, task, decision context,
   and success condition.
2. Identify the project-owned source of truth and accountable owner. When
   ownership is shared or disputed, record that as a finding.
3. Inventory design, documentation, code, tests, and representative live usage.
4. Define anatomy with required, optional, and conditional parts.
5. Define applicable variants and states from the component's behavior. Do not
   require every possible state by default.
6. Record visual treatment, behavior, accessible representation, and evidence
   separately for every applicable state.
7. Test content expansion, localization, empty values, long labels, and error or
   status messages where applicable.
8. Test representative responsive contexts and input paths. Preserve task,
   meaning, and recovery rather than only matching dimensions.
9. Map visual values to project semantic tokens. Route detailed token-system
   consolidation to `review-visuals`.
10. Compare design, documentation, code, and live usage. Classify each inspected
    surface as `aligned`, `drift`, `unknown`, or `not-inspected`.
11. When affordances, action priority or visibility, or grouping cues are
    material, follow the procedure in
    [references/interaction-governance.md](references/interaction-governance.md).
12. When a shared design system's introduction, migration, or adoption is in
    scope, follow the procedure in
    [references/system-lifecycle.md](references/system-lifecycle.md).
13. Record justified identity or task exceptions with evidence, owner, and a
    review trigger. Do not erase distinctive choices merely to match a generic
    component library.
14. Prioritize the smallest changes that restore user-facing behavior,
    discoverability, and maintainer clarity.
15. Validate the applicable structured report.

## State scope

Consider, when applicable:

- default;
- hover for pointer input;
- focus-visible;
- active or pressed;
- selected or checked;
- expanded or collapsed;
- disabled or read-only;
- loading or progress;
- empty;
- error, warning, success, or confirmation;
- dragging, dropping, or reordered;
- timed, dismissed, or interrupted.

A state is covered only when its required behavior and accessible representation
are supported. A static variant alone does not prove coverage.

## Design-code parity

Inspect these surfaces independently:

- design library;
- component documentation;
- source code and tests;
- representative live usage.

Use:

- `aligned` — inspected behavior matches the declared contract;
- `drift` — inspected behavior materially differs;
- `unknown` — evidence exists but is insufficient;
- `not-inspected` — the surface was outside the supplied scope.

A project may intentionally make one surface authoritative. The other required
surfaces still need an update path; source-of-truth status does not excuse drift.

## Interaction and system-governance extension

The optional interaction-governance report, its schema, and its validator are
described in the conditional references above. The extension does not
invalidate an existing component-contract report that is outside its scope.

## Hard gates

Block a mechanical release-ready result when directly supported evidence shows:

- an operable component lacks an accessible name, keyboard path, or visible
  focus where required;
- required error, status, selection, or progress information is absent or
  available only through color, motion, hover, or pointer input;
- a required responsive context clips, hides, or reorders information so the
  primary task or recovery path is lost;
- design or documentation presents required behavior that the implementation
  does not support;
- mock component behavior is presented as live product capability without
  disclosure;
- a required state or accessibility check remains `fail` or `unknown`;
- a non-interactive element uses an operable treatment, or materially different
  actions share a treatment that creates a false expectation, without a
  supported exception;
- a decision context presents competing primary actions without an explicit
  equal-priority requirement or a documented reason that no primary exists;
- a required primary, frequent, or recovery action is hidden behind disclosure
  without a supported reason and an adequate discoverable path;
- a required design-system lifecycle remains `fail` or `unknown` when migration
  or adoption is part of the release scope.

An accepted risk records an owner decision but does not mechanically convert a
failure or unknown into a pass.

## Output

For the base component contract, use:

- [assets/component-contract.schema.json](assets/component-contract.schema.json)
- [assets/component-contract-example.json](assets/component-contract-example.json)

Validate:

```bash
python scripts/validate_component_contract.py path/to/component-contract.json
```

The base validator checks report structure and declared release blockers. It
does not render the component, operate a browser, compare screenshots, or run
assistive technology.

## Recommendation format

For each material finding include:

- evidence state;
- exact component, surface, state, or decision context;
- contract expectation;
- observed drift or unknown;
- user and maintainer impact;
- smallest effective change;
- verification method;
- owner and confidence.

## Completion

The audit is complete when applicable anatomy, states, content, responsive
behavior, accessibility, tokens, ownership, parity, affordances, action
priority, visibility, grouping, and lifecycle are explicit; required failures
and unknowns remain visible; and every recommended change has a repeatable
verification method.
