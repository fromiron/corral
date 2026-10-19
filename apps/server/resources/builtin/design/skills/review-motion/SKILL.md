---
name: review-motion
description: Reviews animations, transitions, parallax, scroll effects, reveals, carousels, and micro-interactions in a website or interface and decides for each pattern whether to keep, reduce, replace, or remove it and how it behaves with reduced motion. Use when simplifying motion, checking a specific animation, or adding reduced-motion behavior. Not for static visual styling or a full accessibility audit.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network.
metadata:
  author: leeskills contributors
  version: "0.7.0"
  languages: "en, ko, ja"
---


# Review Motion

Require a functional reason, a static equivalent, and an appropriate
reduced-motion path for every retained motion pattern.

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

## Inputs

Inventory as available:

- trigger;
- affected elements;
- duration and repetition;
- information conveyed;
- user control;
- essential or nonessential status;
- reduced-motion behavior;
- source code or prototype;
- user task and accessibility baseline.

## Allowed functional purposes

A retained motion should communicate at least one:

- direct input feedback;
- state change;
- causal relationship;
- spatial continuity or navigation context;
- progress;
- error or success;
- user-requested content transition;
- authoring or preview of motion itself.

"Feels alive," "looks premium," "fills empty space," and "all sections should
animate in" are not functional purposes.

## Workflow

1. Inventory each distinct motion pattern.
2. Identify its trigger and information role.
3. Mark whether it is essential to functionality or information.
4. Check whether the same information remains available statically.
5. Choose `keep`, `reduce`, `replace`, or `remove`.
6. Define reduced-motion behavior for every retained nonessential pattern.
7. Remove or replace scroll hijacking and nonessential parallax.
8. Check autoplaying, repeated, flashing, and time-based content separately.
9. Verify keyboard, touch, pointer, zoom, and motion-preference behavior.
10. Record unknown behavior rather than assuming support.

Read [references/motion-rules.md](references/motion-rules.md).

Use:

- [assets/motion-inventory.schema.json](assets/motion-inventory.schema.json)
- [assets/motion-inventory-example.json](assets/motion-inventory-example.json)
- [assets/reduced-motion.css](assets/reduced-motion.css)

Validate:

```bash
python scripts/validate_motion_inventory.py path/to/motion-inventory.json
```

## Decisions

### Keep

Use when motion is necessary and the implementation is safe, or when a
nonessential motion has a clear benefit and a complete reduction path.

### Reduce

Shorten, simplify, remove travel, avoid scale or parallax, or switch to an
instant state change when motion preference is reduced.

### Replace

Use a static state, highlight, text change, progress indicator, or direct
transition that conveys the same meaning with less movement.

### Remove

Use when motion provides no information, competes with the task, delays
content, controls scrolling, or lacks a safe alternative.

## Hard gates

Do not pass when:

- scroll movement is hijacked without an equivalent user-controlled path;
- information or operation exists only in animation;
- a retained nonessential interaction animation has no reduction or disable
  path;
- a removed animation also removes status or feedback;
- motion preference is overridden or ignored without an essential reason.

Treat W3C Animation from Interactions as a strong project guardrail. It is a
Level AAA criterion; state the chosen conformance target separately.

## Completion

Report which of these states was reached; each is separate:

- **Review complete** — every motion pattern has a trigger, purpose, decision,
  and static equivalent, and reduced-motion behavior is either verified or
  recorded as `unknown`. A completed review with unknowns is not a pass for
  the product.
- **Changes complete** — requested edits are applied and the affected patterns
  are rechecked on the changed artifact.
- **Ready to pass the motion gates** — every retained pattern has verified
  reduced-motion behavior, no hard gate fails, and removed patterns kept their
  status or feedback.
