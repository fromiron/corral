# Composition map

Use this file when a focused skill cannot be invoked. When the focused skill's
package is readable at `../../<skill-name>/SKILL.md` relative to this file,
follow that `SKILL.md` and its bundled files instead; the contracts below are
summaries. When it is not readable, these contracts are the **limited** level:
they keep handoffs consistent, but they do not include the focused skill's
scoring rules, schemas, validators, or renderers. Report every limited step as
limited, and do not claim a check or script that is not available ran.

## Delivery order

Preserve the entry skill's delivery convention in this path too: diagnose,
plan, apply requested edits, then verify the changed artifact. Review-only
requests leave artifact files unchanged and include locations, evidence,
minimal fixes, and verification methods. For edits, include the actual diff or
changed-file paths, checks run and results, unverified items, and rollback.
Repeat affected checks after later edits. The JSON handoffs below keep their
existing schemas; record delivery details in the accompanying report.

## Handoff contracts

### Audit design (`audit-design`)

Limited level: run only the quick-pass contract. Record the artifact, user,
task, and inspected material; list up to five material findings with evidence
state (`observed`, `measured`, `inferred`, `unknown`), location, impact,
smallest fix, and verification method; report directly observed hard failures.
Do not produce category scores, a quality or slop-risk score, or a verdict:
the rubric and scorer belong to `audit-design`. Mark accessibility, reflow,
keyboard, and reduced-motion as unknown unless directly verified. Do not infer
AI authorship from style.

### Verify content (`verify-content`)

Produce:

```json
{
  "context": {
    "artifact_type": "",
    "primary_user": "",
    "primary_task": "",
    "success_condition": ""
  },
  "facts": [],
  "content_groups": {},
  "contradictions": [],
  "missing": [],
  "prohibited_generation": [],
  "safe_claims": [],
  "allowed_placeholders": [],
  "questions": []
}
```

### Plan structure (`plan-structure`)

Produce:

```json
{
  "primary_user": "",
  "primary_task": "",
  "dominant_grammar": "",
  "organizing_key": "",
  "content_sequence": [],
  "navigation": {"mode": "none", "items": []},
  "responsive_reflow": [],
  "growth_test": "",
  "rejected_patterns": [
    {"pattern": "", "reason": ""},
    {"pattern": "", "reason": ""}
  ],
  "unknowns": []
}
```

### Review components (`review-components`)

Produce:

```json
{
  "component": "",
  "purpose": "",
  "primary_user_task": "",
  "source_of_truth": {
    "surface": "design | documentation | code | live | split",
    "location": "",
    "owner": "",
    "change_process": ""
  },
  "evidence": [],
  "anatomy": [],
  "variants": [],
  "states": [],
  "responsive_behavior": [],
  "content_rules": [],
  "accessibility": [],
  "token_mappings": [],
  "parity": [],
  "exceptions": [],
  "findings": [],
  "accepted_risks": [],
  "unknowns": []
}
```

For each applicable state, separate visual treatment, runtime behavior,
accessible representation, and evidence. Required failures, unknowns, or parity
drift remain release blockers. Do not copy another system's variants or
dimensions into the project. Preserve a justified identity or task exception
with evidence, owner, and a review trigger.

When affordance, action priority or visibility, grouping, or system adoption is
in scope, also produce the optional interaction-governance extension:

```json
{
  "artifact": "",
  "decision_context": "",
  "evidence": [],
  "affordance_mappings": [],
  "action_groups": [],
  "action_visibility": [],
  "grouping_decisions": [],
  "system_lifecycle": {
    "applicable": false,
    "system_scope": "",
    "governance_model": "not-applicable",
    "authoritative_surfaces": [],
    "contribution_process": "",
    "decision_process": "",
    "versioning_and_changelog": "",
    "roadmap": "",
    "adoption_strategy": "",
    "legacy_mapping": "",
    "coexistence_rules": "",
    "deprecation_gate": "",
    "owners": [],
    "required": false,
    "status": "not-applicable",
    "evidence_state": "observed",
    "evidence": ""
  },
  "findings": [],
  "accepted_risks": [],
  "unknowns": []
}
```

For affordances, compare visual treatment, perceived role, and actual behavior.
For each decision context, declare primary, secondary, and destructive actions,
or record the evidence-backed reason for zero or multiple primary actions. For
action visibility, record importance, frequency, disclosure steps, reason,
space evidence, and alternative path. A design-system lifecycle does not pass
without reviewable ownership, current-to-target mapping, bounded coexistence,
and a deprecation gate.

### Review visuals (`review-visuals`)

Produce:

```json
{
  "observed": {},
  "limits": {},
  "radius_scope": "none | evaluated | unknown",
  "radius_scope_evidence": "",
  "radius_relationships": [],
  "token_proposal": {
    "required": false,
    "artifact_path": "",
    "proposal_json_path": "",
    "foundations": [],
    "primitive_tokens": [],
    "semantic_tokens": [],
    "current_to_proposed": [],
    "open_questions": []
  },
  "exceptions": []
}
```

For shared nested contours, record either the inward semantic token step or a
measured concentric offset. Classify independent components and pills instead
of forcing them into the shared-contour rule. Produce unresolved overages and
radius mismatches. Do not treat default limits or another system's pixel values
as universal laws. When spacing, containers, or typography are in scope, also
record semantic spacing roles, responsive mappings, container ownership, and
the actual font, fallback, script, language, size, weight, letter spacing, line
height, line length, project token, and rendered evidence. Do not use an
external typography table as a pass/fail threshold.

Separate four paths: auditing or normalizing an existing system, proposing a
new system, verifying a rendered proposal, and building proposal files. When
shared tokenization would help, recommend it with exact proposed names and
values and distinguish primitive values from semantic roles. Create the
proposal JSON and the self-contained HTML page only when the user asks for or
chooses that deliverable; then follow the `review-visuals` token proposal
procedure: write the JSON, validate it, render it with the bundled renderer
where Python is available, inspect it at wide and narrow viewports, and report
both paths without implying adoption.

When normalizing, trace numeric proposals to inspected project or rendered
evidence; if that evidence is unavailable, leave values `unknown` instead of
inventing a complete scale. When the user asks for a new system and no project
tokens exist, label each new value as a design hypothesis with its rationale,
keep supplied project values as observed, and leave undecided contexts such as
a dark theme as open decisions. Report contrast or reflow as measured only
after checking the rendered proposal.

Before proposing token values, ask once whether to make an AI proposal or a
guided one, unless the request already says. A guided proposal asks the
user's direction questions together in one message and records each answer;
at the limited level the question bank is unavailable, so ask in plain words
about color family, screen theme, type style, and corner style, and record the
answers in the report. Colors may be written as hex, `rgb()`, `rgba()`, or
`oklch()`.

The proposal schema, validator, renderer, and HTML template belong to the
`review-visuals` package. At the limited level they are unavailable: present
the proposal as a table in the report, state that the deterministic checks and
rendering were not run, and do not hand-build a page that claims to follow the
bundled template.

### Edit copy (`edit-copy`)

For each material copy decision, show:

- locale and location;
- original;
- decision: `correct`, `suggest`, or `keep`;
- issue and evidence status;
- proposed copy when changed;
- evidence and product-voice or language basis;
- unresolved information.

When multiple locales or localized runtime strings are in scope, also compare
meaning, task, terminology, and action priority. Map each canonical message key
to its supplied locale-catalog entries and flag missing or misaligned keys.
Record whether placeholders, markup, plural or select branches, and
locale-aware formatting responsibilities remain intact; do not require
word-for-word parity.

### Review motion (`review-motion`)

For each motion pattern, record:

- trigger;
- purpose;
- essential or nonessential;
- keep, reduce, replace, or remove;
- reduced-motion behavior;
- equivalent static state.

### Check accessibility (`check-accessibility`)

For each check, record:

- criterion or requirement;
- status: pass, fail, unknown, or not applicable;
- evidence;
- impact;
- fix;
- verification method.

### Verify changes (`verify-changes`)

Keep deletion and consolidation decisions and a reversible change plan in
scope. Apply authorized changes before final checks; leave proposals unapplied
for review-only requests. Repeat affected checks if verification prompts an
additional edit.

Declare the operation (`review` or `edit`) and the verification scope. Use
targeted verification for a narrow change: check the changed content,
contract, and behavior, and record unaffected checks as `out-of-scope`. A
targeted result is never release readiness. Use release verification when a
release decision is requested or the change is broad; it allows no
`out-of-scope` checks. Observed hard failures are reported in either scope.

In release verification, run the deletion, substitution, semantic,
five-second, growth, reflow, keyboard, reduced-motion, and provenance tests.
In either scope, when nested rounded surfaces
exist or changed, also run nested-radius coherence verification. When reusable
components changed, verify required anatomy, states, content, responsive
behavior, accessibility, and design-code parity. When affordances, action
hierarchy, disclosure, grouping, or a design-system migration changed, run the
matching conditional checks. Unknown results remain unknown.

## Dependency rules

- Structure depends on grounded user needs and content.
- Copy cannot add facts absent from grounding.
- Component contracts cannot infer runtime support from a design file.
- Design-code parity cannot pass while a required surface is failed, unknown,
  or materially drifting.
- Affordance mapping cannot pass from visual similarity without actual behavior
  or semantic evidence.
- Action priority is scoped to a decision context, not imposed as a page-wide
  quota.
- A disclosed or unavailable important action cannot pass from mere existence;
  its reason and path must be reviewed.
- Design-system adoption cannot pass from a component inventory alone.
- Visual budgets cannot override accessibility or justified identity.
- External spacing, layout, typography, color, iconography, and component values
  cannot override project tokens, behavior, or rendered evidence.
- A low radius-token count cannot override a measured nested-contour mismatch.
- Motion cannot carry information without a static equivalent.
- Pruning cannot delete evidence required for trust or task completion.
- A score cannot override a hard failure.
