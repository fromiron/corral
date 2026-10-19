# Interaction governance

Read this file when affordances, competing actions, disclosure, or grouping
cues are material to the request. A component-state or parity review does not
need it. Run the commands below from the `review-components` skill directory.

## Procedure

1. Map repeated visual treatments to perceived roles and actual behavior. Check
   both directions: similar treatments should create compatible expectations,
   and materially different behavior should remain distinguishable.
2. For each decision context, identify the primary, secondary, destructive, or
   intentionally equal-priority actions. Do not impose one primary action on an
   entire application when the contexts are independent.
3. Record whether each important action is persistent, contextual, disclosed,
   or unavailable. Require evidence for hiding primary, frequent, or recovery
   actions, and record an equivalent discoverable path where one is required.
4. For each relationship, inventory proximity, alignment, similarity, and
   container cues. Retain a container when it communicates a real boundary,
   state, interaction, or repeated-record need—not merely to make the region
   appear designed.

## Report

The interaction-governance extension is optional and does not invalidate an
existing component-contract report that is outside this scope. Use:

- [assets/interaction-governance.schema.json](../assets/interaction-governance.schema.json)
- [assets/interaction-governance-example.json](../assets/interaction-governance-example.json)

Validate:

```bash
python scripts/validate_interaction_governance.py path/to/interaction-governance.json
```

The validator checks the declared contract and fail-closed gates. It does not
operate the interface, measure real discoverability, establish conversion
impact, or prove usability. Set `system_lifecycle.applicable` to `false` unless
a shared system's adoption or migration is in scope.

## Affordance mapping

Record the relationship among:

- visual treatment;
- perceived role or expected operation;
- actual behavior;
- state meaning;
- input paths;
- evidence and exception status.

Check both directions:

1. Elements with the same or materially similar treatment should support
   compatible expectations. A filled action surface should not also represent
   inert metadata unless the difference remains clear through semantics,
   context, and interaction cues.
2. Elements with materially different behavior, risk, or state should remain
   distinguishable when users must tell them apart.

This is not a requirement for every action to look unique. Reuse is desirable
when behavior and priority are compatible. A different treatment also needs a
reason; decorative variation is not a substitute for a contract.

A justified exception records the expected interpretation, evidence, owner,
accessibility representation, and review trigger.

## Action priority by decision context

Evaluate action hierarchy within one user decision, task stage, or repeated
record—not as a universal rule that an entire page or application may contain
only one primary action.

For each decision context record:

- user decision;
- primary action, when one exists;
- secondary alternatives;
- destructive or exceptional actions;
- keyboard and reading order;
- visual prominence;
- evidence for equal priority or for intentionally having no primary action.

Prefer one primary action when the task has a default next step. Do not invent a
primary action for neutral navigation, peer choices, editors with independent
tool groups, or other contexts where the product evidence establishes no single
default.

Keep destructive actions distinguishable from routine primary actions. Visual
priority must not change accessible order or naming in a way that obscures the
task.

## Action visibility and disclosure cost

Classify actions as:

- `persistent` — directly available in the current context;
- `contextual` — appears when the relevant object or state is active;
- `disclosed` — available after opening an explicit menu, panel, or details
  control;
- `unavailable` — not provided in the current context or reachable path.

For each action record importance, expected frequency, recovery value,
disclosure steps, available-space evidence, hiding reason, and any equivalent
visible path.

An overflow menu is not automatically a defect. Disclosure may be appropriate
for destructive, advanced, low-frequency, permission-sensitive, or
space-constrained actions. Conversely, a primary, frequent, or recovery action
should not pass merely because it technically exists. Hiding it requires a
supported reason and an adequate discoverable path.

Do not infer frequency from visual prominence. Use research, analytics, product
requirements, or an explicit inference label.

## Grouping cues and container strength

Relationships can be communicated through:

- proximity;
- alignment;
- similarity;
- a shared container.

A container is a strong cue and adds visual and implementation weight. Use the
lightest sufficient set of cues for the relationship, but do not require a fixed
order in every interface.

Retain or add a container when it communicates a real boundary, selected or
editable state, interaction target, repeated record, drag region, ownership,
error scope, or other task-relevant grouping. Remove it when proximity,
alignment, and similarity preserve the same relationship and the container adds
no state, boundary, or interaction value.

Test the result with real content growth, responsive reflow, keyboard focus,
and the semantic source order. A borderless layout is not simpler when the
relationship becomes ambiguous.
