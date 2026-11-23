---
name: map-flows
description: Maps how people move through a product toward a goal as a graph of states and actions, keeps the intended design separate from evidence about the built product, and analyzes routes, effort, recovery after failure, dead ends, and regressions between revisions, optionally keeping the map and recorded runs in the project. Use when a request concerns a journey across screens or states such as onboarding, checkout, sign-in, or settings, where people get stuck or cannot recover, or whether a change broke a critical path. Not for the content structure of one page, the states of one component, visual styling, copy edits, or claims about conversion or real user behavior without research.
license: MIT
compatibility: Agent Skills-compatible clients. Core workflow is instruction-only; optional Python 3.9+ scripts use the standard library and no network. Recording a run uses whatever browser or test tool the client already provides.
metadata:
  author: leeskills contributors
  version: "0.8.0"
  languages: "en, ko, ja"
---

# Map Flows

Keep one map of how a person gets from an entry point to a goal, and keep what
was designed apart from what is known about the product.

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

This skill owns the journey graph: states, the actions that connect them, the
conditions on those actions, and the evidence for each. It supplies findings to
the skills that own the judgment:

| Question | Owner |
|---|---|
| Which screens exist and what grammar organizes one page | `plan-structure` |
| Whether a control looks operable, how prominent or hidden an action should be, what an error state must contain | `review-components` |
| Whether a path works for keyboard and assistive technology | `check-accessibility` |
| Whether a change is ready to release | `verify-changes` |
| How states connect, which routes exist, where they break, what changed | **this skill** |

A map is a model. It does not measure comprehension, discoverability,
conversion, or how real people behave; those need research or product data.
A shorter route is not automatically a better one.

## Two layers, never merged

Every transition carries two separate statements.

**Intent** says whether the path was designed:

- `approved` — an accountable owner decided it, or supplied design says so;
- `proposed` — a design hypothesis you or someone else suggested, not approved;
- `none` — the product has this path and no design decision is recorded.

**Evidence** says what is known about the product, using exactly:

- `observed` — the control or route is present in inspected code, design, or a
  screen. Presence is not proof that it works;
- `inferred` — reasoned from other material; say what it rests on;
- `unknown` — not found or not inspected;
- `measured` — a recorded run performed the action and landed on the declared
  state.

`measured` cannot be written into a map. It exists only when a run file
records the step, so a transition is verified by executing it or not at all.
Never record a run you did not execute, and never describe a designed path as
product behavior.

The analysis keeps the layers apart as well: **intended** uses approved and
proposed transitions and answers "does the design work"; **as-built** uses only
transitions with evidence and answers "does the product work, as far as we
know".

## Choose a mode

| Mode | Use when | Result |
|---|---|---|
| Design | A flow is being designed before or during implementation | Intended transitions, each labeled `approved` or `proposed`, with evidence `unknown` until something is built |
| Inspect | An existing product's flow is reviewed or improved | As-built transitions with evidence, recorded runs when runtime access exists, and the gap to the design |
| Compare | A change may have affected a mapped flow | Regressions, improvements, and neutral changes between two revisions |

## Inputs

Use what is available and record the rest as unknown:

- the user, their goal, and the success condition, grounded by
  `verify-content` when the request includes it;
- the structure decision from `plan-structure`, when one exists;
- an existing flow map in the project: look for `*.flow.json` before drawing a
  new one;
- routes, screens, design files, source code, and tests;
- a running build and a browser or test tool, when the client provides them;
- the product revision under review.

## Procedure

Read [references/flow-model.md](references/flow-model.md) before writing or
editing a map or a run.

### Design

1. Restate the user, goal, and success condition. If any is unknown, say so and
   keep the map provisional.
2. List the states the person passes through and the action that leads from
   each to the next. Name actions by what the person does.
3. Add the branches that decide success: conditions such as signed-in, each
   failure the person can reach, and how they get back or out.
4. Mark transitions the owner decided as `approved` and your own suggestions as
   `proposed`. Leave undecided branches in `unknowns`; do not fill them in.
5. Run the analysis. Resolve an unreachable goal, a dead end, or a failure
   without recovery in the design before handing it on.
6. Hand the map to the skills that build on it. It is still a design: nothing
   in it is evidence about a product.

### Inspect

1. Restate the journey, the scope, and the evidence you can reach.
2. Start from the project's map when one exists; otherwise draft the map from
   code, routes, design, and screens. Label what you read as `observed` and
   what you concluded as `inferred`.
3. Add paths the product has but the design does not, with intent `none`.
4. When the client can operate the product, walk each journey and record a
   run as described in
   [references/recording-runs.md](references/recording-runs.md). Walk it again
   with the keyboard when keyboard access is in scope.
5. Run the analysis and read it with
   [references/analysis.md](references/analysis.md).
6. Report each finding with its evidence and route it to the owning skill.
   Do not turn a finding into an edit unless edits were requested.

### Compare

1. Confirm both sides describe the same journey under the same conditions:
   input method, viewport, locale, and starting facts. A revision identifier
   names what was compared; it does not show that anything was verified.
2. Compare the earlier and later map and their runs with the script below.
3. Report regressions first. Report changes in effort and route as changes for
   a person to judge, never as wins or losses by count.
4. State what could not be compared, and hand the result to `verify-changes`.

## Keeping the map in the project

The map is project knowledge that the next session reads instead of
rediscovering. It is optional, and files are written only on request.

- **When to write.** Create or change map and run files when the user asks to
  save, record, or update them, or when the project already keeps a map and a
  requested edit changes a mapped flow. Then the map update belongs in the
  change plan and the changed-file list. In a review-only request, show the
  proposed map or patch in the reply and change no file.
- **Where.** Follow the project's existing location. Otherwise use
  `ux-flows/<name>.flow.json` for maps and `ux-flows/runs/<name>.run.json` for
  runs, so reviewers see flow changes in ordinary diffs.
- **Runs are a log.** Never edit or delete a recorded run to change a result.
  Record a new run.
- **Baselines.** A journey's `baseline_run` names the run that comparisons
  refer to. Set or move it only after the user approves that run as the
  reference.
- **Privacy.** Store no credentials, tokens, cookies, or personal data. Refer
  to evidence by repository path or run id, and mask secrets in URLs.
- Do not commit or push these files unless asked.

## Scripts

Run from this skill's directory. Each script prints JSON, accepts `--output`,
and looks for runs in the `runs` directory next to the map.

```bash
python scripts/validate_flow.py path/to/name.flow.json
python scripts/analyze_flow.py path/to/name.flow.json --revision <revision>
python scripts/compare_flows.py path/to/before.flow.json path/to/after.flow.json
python scripts/render_flow.py path/to/name.flow.json --output flow-map.html
```

- `validate_flow.py` checks identifiers, references, conditions, evidence
  rules, and that every run is one continuous walk from the journey's entry.
- `analyze_flow.py` reports, per journey and scenario and for each layer,
  whether the expected end is reachable, the shortest route with its user
  actions, inputs, and screens, the steps no route can avoid, dead ends, and
  whether each failure state can recover.
- `compare_flows.py` exits non-zero when it finds a regression. To compare
  with an earlier commit, write that revision's map to a temporary file first.
- `render_flow.py` writes a self-contained page in English, Korean, or
  Japanese (`--language`), or a Mermaid flowchart (`--format mermaid`) for a
  pull request or a Markdown report. Render only when the user asks for a page
  or a diagram.

Use:

- [assets/flow-map.schema.json](assets/flow-map.schema.json) and
  [assets/flow-map-example.json](assets/flow-map-example.json)
- [assets/flow-run.schema.json](assets/flow-run.schema.json) and
  [assets/flow-run-example.json](assets/flow-run-example.json)
- [assets/flow-report-template.md](assets/flow-report-template.md) for a
  written report

The scripts read declarations and recorded runs. They do not open the product,
and a valid map is not evidence that a journey works. Without Python, write
the map by the model reference, state that the deterministic checks did not
run, and report routes and dead ends as inferred.

## Hard gates

When a pass or readiness statement about a journey is requested, block it while
directly supported evidence shows any of:

- a critical journey whose expected end no recorded run reaches at the revision
  under review, when a runtime check was required;
- a step of a critical journey whose latest run was blocked or diverged;
- a failure state on a critical journey with no route back to the goal and no
  recorded reason;
- a run that passed a step whose condition the map says was not met, until the
  product or the map is corrected;
- a critical route presented as verified while it rests on inferred or unknown
  evidence.

Only `observed` or `measured` evidence creates a gate. A problem that exists
only in the model is a finding. An accepted risk records an owner decision; it
does not turn a blocked step into a pass.

## Recommendation format

For each finding include:

- evidence state and the layer it was found on;
- the journey, scenario, and exact state or transition;
- what the map or run shows;
- the effect on the person trying to reach the goal;
- the smallest effective change;
- how to verify it, including the run to record;
- the skill that owns the judgment, when it is not this one.

## Completion

A mapping task is complete when the journeys in scope have a declared goal and
success condition; intended and as-built statements are separate and labeled;
every claim of verification points to a recorded run; unreachable goals, dead
ends, failures without recovery, and run drift are reported or resolved; and
the report states what was not run and why.
