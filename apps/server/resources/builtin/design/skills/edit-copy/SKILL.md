---
name: edit-copy
description: Audits and edits product, interface, landing-page, documentation, portfolio, case-study, or product-narrative copy for specificity, factual support, natural language, and consistency with the product's established voice. Use for vague or inflated claims, translation-like or stiff wording, mixed register, terminology drift, multilingual screens, or localized runtime strings. Not for deciding whether sources support a claim; preserves meaning and approved voice and never infers authorship from prose style.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network.
metadata:
  author: leeskills contributors
  version: "0.7.0"
  languages: "en, ko, ja"
---


# Edit Copy

Make copy concrete, supportable, natural in its language, and consistent with
the surrounding product without flattening its voice.

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

## Context

Collect as available:

- a grounded content inventory for claims, outcomes, customers, prices, and
  capabilities;
- the product style guide, terminology list, and approved nearby copy;
- the intended audience, task, surface, and locale;
- equivalent copy from other supported locales when internationalization is in
  scope;
- message keys, placeholders, markup, plural or select branches, and formatting
  ownership when editing localized runtime strings.

If evidence is missing, flag the claim or write around it; do not invent
support or a house style.

Use the supplied content evidence or `verify-content` findings to establish
which claims are allowed. This skill improves their expression; a clearer or
more natural sentence does not make an unsupported claim true.

## Authority

Use this order when guidance conflicts:

1. verified meaning, user instructions, and legal, safety, or accessibility
   requirements;
2. the product's explicit style and terminology rules;
3. approved copy from the same product and locale;
4. the audience, task, and interaction context;
5. language-specific official guidance;
6. editor preference.

An outside guide can support clarity and usage decisions. It does not supply
the product's personality.

## Specificity questions

Use the subset relevant to each statement:

1. Who acts or provides the thing?
2. What exactly happens?
3. For whom?
4. In what context or workflow?
5. What result is supported?
6. What constraint, price, time, or scope matters?
7. What evidence supports the statement?
8. What should the reader do next?

Not every sentence needs all eight answers. It needs enough detail to perform
its job.

## Language and voice questions

Use the subset that fits the artifact:

1. Does the wording sound natural in the target locale, or does it preserve the
   source language's order and idiom?
2. Does formality, politeness, humor, and sentence rhythm match approved nearby
   copy?
3. Are product terms, labels, and calls to action consistent across the flow?
4. Do localized versions preserve meaning, task, and action priority without
   forcing the same sentence structure?
5. Do localized runtime strings preserve their keys, placeholders, markup,
   branches, and locale-aware formatting contract?
6. Is an unusual phrase intentional product voice or an isolated inconsistency?
7. Is there enough voice evidence to correct the copy, or should the change be
   offered as a suggestion?

## Workflow

1. Identify the audience, task, surface, source language, target locale, and
   available voice evidence.
2. Preserve meaning and action priority. Translate only when requested.
3. Split copy into atomic claims and actions, then trace factual claims to
   grounded evidence.
4. Run the substitution test: replace the name with an unrelated competitor
   and flag wording that remains equally plausible.
5. Flag unsupported superlatives, quantified outcomes, universal claims, and
   social proof.
6. Review each locale for natural syntax, register, terminology, rhythm, and
   fit with approved surrounding copy.
7. Compare multilingual versions by meaning, task, terminology, and action
   priority rather than word-for-word similarity.
8. Preserve message keys and runtime syntax. For locale catalogs, confirm that
   each canonical key maps to the same meaning and action in every supplied
   locale. Keep every required placeholder, markup boundary, plural or select
   branch, and locale-aware formatting responsibility; flag missing or
   misaligned keys and implementation context instead of guessing.
9. Classify each material copy decision as `correct`, `suggest`, or `keep`:
   - `correct` for grammar, mistranslation, ambiguity, terminology drift, or a
     clear conflict with an established product rule;
   - `suggest` for rhythm, tone, formality, or another reasonable style choice;
   - `keep` for intentional, supported product voice.
10. Remove duplicated promises and filler, then rewrite with concrete nouns,
   active verbs where they improve clarity, relevant constraints, and a clear
   action.
11. Show unresolved claims and uncertain voice decisions instead of silently
    weakening, normalizing, or fabricating them.

Read [references/copy-rules.md](references/copy-rules.md).
When tone, naturalness, translation, or multiple locales are in scope, also
read [references/language-and-voice.md](references/language-and-voice.md).

Optional lint:

```bash
python scripts/lint_copy.py path/to/copy.txt
python scripts/lint_copy.py path/to/copy.txt --format json
```

The linter uses [references/phrase-watchlist.txt](references/phrase-watchlist.txt).
A match is a review prompt, not an automatic failure. The linter does not score
naturalness, locale quality, product voice, or authorship.

## Rewrite rules

- Prefer product, service, task, user, action, price, date, scope, and supported
  result over abstract value language.
- Replace "seamless" with the actual integration or reduced step count only if
  known.
- Replace "powerful" with the capability that matters.
- Replace "innovative" with what is materially different.
- Replace "trusted by" with attributable customers or remove it.
- Replace "save time" with a supported mechanism or measured result.
- Do not transform uncertainty into certainty.
- Do not invent a metric to make a sentence more specific.
- Do not require every sentence to become longer. A concrete sentence can be
  shorter.
- Do not flatten every product into a generic plain-language voice.
- Do not copy Google, Microsoft, government, or another organization's house
  style into the product.
- Do not treat a common phrase, formal tone, or awkward sentence as evidence
  that AI wrote it.

## Output

Use [assets/rewrite-template.md](assets/rewrite-template.md).

For every material decision include:

- locale and location;
- original;
- action: `correct`, `suggest`, or `keep`;
- issue;
- evidence status;
- proposed copy when changed;
- product-voice and language basis;
- unresolved information.

If the user asks for direct edits, apply confirmed corrections and clearly
separate optional suggestions. Do not force the full template onto a simple
copy-editing request.

## Completion

Copy passes when the primary identity, offer, task, constraints, proof, and
action are understandable; factual claims are supported or explicitly
qualified; each reviewed locale reads naturally for its audience within the
available evidence; uncertain judgments are explicit; and product voice,
terminology, meaning, action priority, and localization runtime contracts remain
coherent across the flow.
