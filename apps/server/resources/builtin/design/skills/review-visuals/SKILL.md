---
name: review-visuals
description: Audits or defines the visual value system of a website, interface, landing page, portfolio, or design system, including layout grammars, spacing and container roles, typefaces and type roles, typography settings, colors, radii and nested-radius relationships, shadows, surfaces, CTA styles, and imagery. Use when visual variants need consolidation, a relationship such as nested radii needs checking, or the user asks for token definitions or a token proposal page. Not for component behavior, states, or parity, motion behavior, or a full accessibility review.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network.
metadata:
  author: leeskills contributors
  version: "0.7.0"
  languages: "en, ko, ja"
---


# Review Visuals

Limit the number of unrelated visual rules so content and interaction remain
legible.

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

## Definition

This skill uses "entropy budget" as a practical inventory of visual variants.
It is not a formal information-theory calculation.

## Choose a path

Identify the path from the request before inspecting values. Paths can
combine, but each keeps its own evidence rule.

| Path | When | Numbers come from | Output |
|---|---|---|---|
| Audit or normalize an existing system | Default for an existing artifact | Project tokens, CSS or theme values, computed styles, rendered evidence | Findings and recommendations |
| Propose a new system | The user asks for a new visual system and no project system exists for the scope | Stated requirements, content, brand, and platform constraints, labeled as design hypotheses | Proposal with rationale, assumptions, and open decisions |
| Verify a proposal | After a proposal is rendered | Contrast, reflow, and relationship checks run on the rendered proposal | Check results; unrendered values stay unverified |
| Build a token proposal file | Only when the user asks for, or explicitly chooses, a proposal JSON or HTML page | One of the paths above | Proposal JSON and HTML page |

- Never present a design hypothesis as an existing project value, standard, or
  measurement. Never present an unrendered value as measured.
- Leave contexts the user has not decided, such as a dark theme, as open
  decisions instead of filling values.
- An audit can end with findings. When a shared system would help, recommend a
  token proposal and offer the file; do not create files the user did not ask
  for.

## Inputs

Use as available:

- design tokens;
- component inventory;
- screenshots or rendered pages;
- CSS or theme definitions;
- spacing, breakpoint, and container tokens;
- typography specimens and computed styles;
- brand requirements;
- data-visualization needs;
- interaction and state requirements;
- selected information structure.

## Default budget

| Metric | Default |
|---|---:|
| Dominant layout grammars | 1 |
| Typeface families | 1 |
| Typeface families, maximum without exception | 2 |
| Type roles | 4–6 |
| Accent colors | 0–1 |
| Radius tokens | 0–2 |
| Shadow levels | 0–1 |
| Surface styles | 1–3 |
| Primary CTA styles | 1 |
| Secondary CTA styles | 0–1 |
| Motion patterns | 0–2 |
| Decorative image families | 0 |

Do not set universal numeric defaults for breakpoint values, spacing steps,
letter spacing, or line height. Use the project's tokens and rendered evidence.

Read [references/budget-rules.md](references/budget-rules.md) before applying
the defaults to data-rich, editorial, expressive, or brand-led work. Otherwise
read only the sections in scope:

- spacing or responsive containers:
  [spacing roles](references/budget-rules.md#spacing-roles-and-responsive-relationships)
  and [container ownership](references/budget-rules.md#responsive-container-ownership);
- typography:
  [type roles and typography context](references/budget-rules.md#type-roles-and-typography-context);
- nested rounded surfaces:
  [nested radius coherence](references/budget-rules.md#nested-radius-coherence);
- CTA treatments or grouping:
  [CTA styles](references/budget-rules.md#cta-styles-and-action-priority) and
  [grouping cues](references/budget-rules.md#grouping-cues);
- an overage that may be justified:
  [legitimate exceptions](references/budget-rules.md#legitimate-exceptions).

## Workflow

1. Identify the selected dominant structure.
2. Identify project-owned tokens, breakpoints, and documented exceptions before
   consulting external systems or repository defaults.
3. Inventory observed values for every budget metric and declare whether
   spacing, typography, responsive containers, and nested radii were evaluated
   or remain unknown.
4. Classify spacing uses as content gap, section gap, container padding, or a
   documented exception; merge raw values that perform the same role.
5. Compare spacing and container mappings at representative project
   breakpoints. Verify that responsive changes preserve grouping and avoid
   overflow or desktop-sized empty regions.
6. Evaluate typography by semantic role and actual typeface, fallback, script,
   language, size, weight, letter spacing, line height, line length, and
   rendered result.
7. Classify each nested rounded pair as a shared contour, an independent
   component, or a pill or circle, then test the applicable relationship.
8. Merge aliases, distinguish semantic variants from decorative variants, and
   compare observed counts with project limits or defaults.
9. Require an exception for each unexplained overage or measured relationship
   mismatch.
10. Test whether removing, merging, or remapping a variant loses state,
    hierarchy, meaning, brand recognition, readability, or accessibility.
11. Consolidate duplicate CTA, card, surface, radius, shadow, spacing, and type
    patterns while preserving justified communication roles.
12. Produce a budget report and verification plan.

Use:

- [assets/visual-budget.schema.json](assets/visual-budget.schema.json)
- [assets/visual-budget-example.json](assets/visual-budget-example.json)

Check a structured budget:

```bash
python scripts/check_budget.py path/to/visual-budget.json
```

The script requires every core metric in both `observed` and `limits`. Omitted
nested-radius scope is treated as unknown. Documented exceptions and unverified
radius scope return `review-required`, not an automatic pass.

The script validates count metrics and declared radius relationships. It cannot
decide whether font-dependent typography or responsive spacing is appropriate;
record those conclusions separately with project and rendered evidence.

## Token proposal

Recommend a token proposal when repeated raw values, inconsistent naming,
responsive drift, or unclear ownership indicate that a shared system is
needed. Build the proposal JSON and HTML page only when the user asks for
token definitions or a proposal page, or explicitly chooses that deliverable.
Then read [references/token-proposal.md](references/token-proposal.md) for the
normalize and new-system evidence gates, token decisions, the
write → validate → render → inspect procedure, and the page requirements.

Before proposing token values, choose how to gather the direction. If the
request does not say, ask the approach question from
[assets/token-questions.json](assets/token-questions.json) once:

- **AI proposal (`auto`)** — analyze the project or brief and propose, as in
  the paths above;
- **Guided (`guided`)** — ask the user a few direction questions first, then
  propose; read
  [references/token-questions.md](references/token-questions.md).

Skip the question when the request already implies an approach: "just
propose" means auto; "ask me first" or stated preferences mean guided. When
no answer is possible, such as in a non-interactive run, use auto. Print the
question in the user's language with
`python scripts/token_questions.py --stage approach --language ko`, or ask it
from the question bank in plain text in any client.

These limits apply even without those files: normalized values trace to
project or rendered evidence or stay `unknown`; new-system values are labeled
design hypotheses with a rationale; a user's answer is recorded and traced,
but it cannot lower contrast minimums; undecided contexts stay open; and a
proposal is not evidence that the project adopted the tokens.

## Rules

- Do not count text colors required for data or status as arbitrary accents.
- Prefer project tokens and breakpoints over values imported from another
  design system.
- When proposing a shared system, provide concrete token names and values
  rather than only saying to "standardize" them. Trace normalized values to
  project evidence; label new-system values as design hypotheses with a
  rationale.
- Leave a proposed numeric value `unknown` when neither project evidence nor a
  requested new-system rationale supports it. Do not fabricate completeness.
- Require spacing values to express content grouping, section separation,
  container padding, or a documented exception. Do not require a universal
  4/8 scale.
- Verify responsive spacing and container behavior as relationships. Do not
  require every spacing token to shrink or every inner element to fill 100%.
- Do not apply universal letter-spacing or line-height thresholds. Flag a
  typography defect only from a project-token mismatch or rendered evidence
  such as clipping, overlap, broken wrapping, or impaired reading.
- Do not merge states that must remain distinguishable.
- Do not remove focus indicators, error states, selected states, or disabled
  states to meet a budget.
- A second typeface may be justified by an editorial, language, code, or brand
  role.
- A shadow may communicate elevation or drag state; a decorative glow does not
  inherit that justification.
- Cards are justified by meaningful boundaries, repeated records, or
  interaction—not by a desire to make every item look designed.
- A low radius-token count does not pass by itself. Shared nested contours must
  use a coherent inward relationship; independent components and pills require
  an explicit classification rather than forced arithmetic.
- Decorative images and authentic work samples are different categories.
- A documented exception is reviewable, not automatically acceptable.

## Output

For each metric include:

- observed count;
- limit;
- source of limit;
- overage;
- semantic roles;
- spacing roles and responsive mappings when in scope;
- container padding and width ownership when in scope;
- typography context, project token, and rendered evidence when in scope;
- duplicate candidates;
- nested-radius scope, relationships, rule, and evidence;
- exception and evidence;
- consolidation recommendation;
- verification method.

## Completion

The budget passes automatically only when no overage or measured radius
mismatch remains and nested-radius scope is not unknown. A documented exception
requires human review of the communication need before acceptance, and
accessibility states must remain intact. Do not fail or pass typography or
spacing solely because it differs from an external design system's numeric
table.
