---
name: audit-design
description: Diagnoses an existing website, UI, portfolio, landing page, design system, or generated visual artifact for generic, unsupported, redundant, inaccessible, or purposeless design signals and prioritizes what to remove or fix. Use for one diagnostic pass, such as a quick read of a page or screenshot, an anti-slop or simplification audit, or a scored audit when the user asks for scoring. Not for coordinating a multi-area redesign, verifying a specific change, editing copy, or deciding whether AI authored the artifact.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network.
metadata:
  author: leeskills contributors
  version: "0.7.0"
  languages: "en, ko, ja"
---


# Audit Design

Identify observable design and content problems, distinguish evidence from
inference, score the artifact, and prioritize remediation.

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

## Boundary

This is not an AI-authorship detector. Similar visual patterns can result from
templates, conventions, deadlines, team decisions, or generative tools. Report
the symptom and its impact, not an unsupported origin story.

## Inputs

Collect as available:

- screenshots or live rendered views;
- copy;
- DOM or semantic structure;
- component and token inventory;
- motion inventory;
- user and primary task;
- real proof, constraints, and outcomes;
- product style, terminology, approved nearby copy, and supplied locales when
  voice or locale drift is in scope;
- target viewport and accessibility baseline.

Record anything not inspected.

## Evidence classes

Use exactly:

- `observed`
- `measured`
- `inferred`
- `unknown`

An inferred finding must state its supporting evidence. An unknown item receives
no passing credit merely because it was not visible.

## Audit procedure

1. Define the artifact, intended user, primary task, and success condition.
2. Inventory all visible sections, component families, CTAs, claims, images,
   motion patterns, and navigation structures.
3. Compare the inventory against
   [references/generic-default-catalog.md](references/generic-default-catalog.md).
   Record each directly visible cue as `observed` with its location, and record
   its interpretation — cause, justification, authenticity, or product
   correspondence — with its own evidence state per the catalog rules.
4. Mark unsupported claims and absent evidence before judging aesthetics.
5. Find repetition that adds no new decision-relevant information.
6. Identify visual variants that do not communicate state, hierarchy, or brand.
7. Inspect nested rounded surfaces for repeated tokens, inward semantic steps,
   or measured contour offsets; do not treat token count alone as coherence.
8. Check whether images demonstrate real work or merely occupy space.
9. Check motion for a functional purpose and reduced-motion behavior.
10. Run the accessibility guard or mark untested items as unknown.
11. Score every category using [references/rubric.md](references/rubric.md).
12. List project hard failures independently of the score.
13. Order recommendations by user impact, confidence, and reversibility.

## Scoring

Use the bundled schema and template:

- [assets/audit.schema.json](assets/audit.schema.json)
- [assets/audit-example.json](assets/audit-example.json)
- [assets/report-template.md](assets/report-template.md)

The score is a decision aid, not a scientific measure.

When a structured audit JSON is available, run:

```bash
python scripts/score_audit.py path/to/audit.json
```

Use `--output result.json` to save the computed result.

## Quick-pass mode

When invoked by `design-workflow` in quick-pass mode, or when the user asks for a
fast review without a score or release decision:

1. Run audit steps 1–9 only, as far as the supplied material supports them.
2. Do not produce category scores, a quality score, a slop-risk score, or a
   verdict.
3. Report up to five material findings with evidence states and locations.
   Never pad the list; fewer findings are a valid result.
4. Mark accessibility, reflow, keyboard, and reduced-motion checks as unknown
   unless directly verified.
5. Report directly observed hard failures, but do not issue a passing or
   release decision.
6. State which checks were skipped and offer the full scored audit as the
   follow-up.

## Project hard failures

Block a passing verdict when directly supported evidence shows any of:

- fabricated customer, metric, quote, award, result, capability, or case study;
- mock UI presented as a functioning product without disclosure;
- keyboard focus, labels, errors, semantic structure, or alternatives removed
  for visual cleanliness;
- scroll hijacking without an equivalent user-controlled path;
- essential information available only through motion, color, hover, or a
  pointer-only interaction;
- nonessential interaction motion without a disable or reduction path;
- unsupported claims presented as verified facts.

Label legal or standards compliance separately. A project hard failure is not
by itself a legal conclusion.

## Recommendation format

For every recommendation include:

- evidence state;
- exact location;
- problem;
- user or trust impact;
- smallest effective change;
- verification method;
- confidence.

Prefer removal or consolidation before adding new components.
Route detailed nested-radius measurement to `review-visuals` and verify
the repaired relationship with `verify-changes`.

## Completion

In the full audit, conclude with:

- quality score;
- derived slop-risk score;
- verdict;
- hard failures;
- up to five prioritized changes;
- unknowns that could change the result.

In quick-pass mode, conclude with the prioritized findings, directly observed
hard failures, skipped checks, and unknowns — no scores and no verdict.
