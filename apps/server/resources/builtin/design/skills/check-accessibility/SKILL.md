---
name: check-accessibility
description: Checks that a website or interface keeps accessible names, semantics, headings, labels, errors, text alternatives, keyboard operation, visible focus, sufficient contrast, reflow, target usability, status feedback, and reduced-motion behavior, especially after simplification or redesign. Use for accessibility-focused reviews, contrast or keyboard checks, and the accessibility step of anti-slop work. Not for general visual or copy critique, and not a full WCAG conformance claim from screenshots or automated checks alone.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network.
metadata:
  author: leeskills contributors
  version: "0.7.0"
  languages: "en, ko, ja"
---


# Check Accessibility

Protect necessary accessibility cues and behavior while reducing visual and
structural excess.

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

## Principle

Minimal appearance is not permission to remove information, states,
affordances, semantics, or recovery paths.

## Evidence boundary

A screenshot can support observations about visible hierarchy, apparent text
size, or possible contrast problems. It cannot establish keyboard operation,
accessible names, reading order, status announcements, reflow behavior, or full
WCAG conformance.

Label untested requirements as `unknown`.

## Baseline checks

Use [references/wcag-checklist.md](references/wcag-checklist.md) and apply only
requirements relevant to the artifact.

At minimum consider:

- non-text alternatives;
- semantic information and relationships;
- meaningful order;
- color not used as the only cue;
- text and non-text contrast;
- text resizing and spacing;
- reflow at narrow viewport or high zoom;
- keyboard access and no keyboard trap;
- visible, ordered, and unobscured focus;
- descriptive headings, labels, and link purpose;
- pointer alternatives and target size;
- error identification, instructions, and recovery;
- accessible name, role, value, and status messages;
- pause or control for moving content;
- reduced-motion behavior.

## Workflow

1. Record target standard and level. Default to WCAG 2.2 AA when the project
   has not supplied a different baseline; state that this is a working target.
2. Record available evidence: screenshot, DOM, CSS, running page, keyboard test,
   automated scan, screen reader, zoom, and motion settings.
3. Select applicable checks from the checklist.
4. Test programmatically verifiable items with appropriate tools when
   available.
5. Perform manual keyboard, focus, zoom/reflow, and assistive-technology checks
   where required.
6. Record pass, fail, unknown, or not applicable with evidence.
7. Identify any accessibility feature proposed for removal.
8. Reject simplification that hides or deletes necessary cues.
9. Provide the smallest effective fix and a verification method.
10. Separate WCAG findings from broader usability recommendations.

Use:

- [assets/accessibility-report.schema.json](assets/accessibility-report.schema.json)
- [assets/accessibility-report-example.json](assets/accessibility-report-example.json)

Validate report completeness:

```bash
python scripts/validate_accessibility_report.py path/to/accessibility-report.json
```

This script validates the report contract; it does not test a website.

## Non-negotiable simplification rules

Do not remove:

- visible keyboard focus;
- labels in favor of placeholders alone;
- heading semantics in favor of styled text;
- error text in favor of color alone;
- text alternatives for informative images;
- status messages without an accessible equivalent;
- skip or bypass mechanisms where repeated blocks require them;
- native keyboard behavior without an accessible replacement;
- content needed at zoom or narrow widths.

Do not make text faint or controls ambiguous merely to reduce visual weight.
Do not present text-spacing resilience values or a third-party typography table
as universally ideal default letter spacing or line height.

## Contrast and motion

For WCAG 2.2 AA, normal text generally requires at least 4.5:1 and large text
at least 3:1. Relevant user-interface components and graphical objects have
separate non-text contrast requirements.

Interaction motion reduction is included as a project guardrail. W3C
Animation from Interactions is Level AAA; report that distinction rather than
mislabeling it as AA.

## Completion

A mechanical release-ready result is blocked by every failed check and by every
required check that remains unknown. Recording an accepted risk does not clear
the blocker; an accountable owner must make that release decision outside the
validator. The final report must state what was tested, how, and what was not
tested.
