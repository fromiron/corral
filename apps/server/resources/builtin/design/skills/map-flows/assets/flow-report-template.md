# Flow review: [product, journey]

Keep the sections the request needs. Lead with what a reader must act on.

## Summary

- Request: review only / edits requested
- Mode: design / inspect / compare
- Revision reviewed:
- Journeys in scope:
- Result: [one sentence per journey: does the design reach the goal, does the product, how much of the route did a run verify]
- Not run or not inspected:

## Findings

One block per finding, most severe first.

### [Short name of the finding]

- Where: [journey] · [scenario] · [state or transition id]
- Layer and evidence: design / product · observed / measured / inferred / unknown
- What the map or run shows:
- Effect on the person:
- Smallest change:
- How to verify: [the run to record or the check to repeat]
- Owner: [this skill, or the skill that judges it]

## Journeys

| Journey and scenario | Design | Product | Effort | After a failure |
|---|---|---|---|---|
| | reaches the goal / does not / not designed | reaches the goal / does not / no evidence | actions · inputs · screens | recovers / exit only / trapped |

Effort counts describe the shortest route. They are not a score.

## Evidence

| Evidence | Transitions | Source |
|---|---:|---|
| Verified by a run (`measured`) | | [run ids] |
| Seen, not run (`observed`) | | |
| Inferred | | |
| No evidence (`unknown`) | | |

## Runs recorded

| Run | Journey, scenario | Outcome | Input, viewport | Revision |
|---|---|---|---|---|

## Comparison

Use only in compare mode.

- Compared: [earlier revision] → [later revision], under [input, viewport]
- Regressions:
- Improvements:
- Changes for a person to judge:
- Not compared, and why:

## Map changes

- Proposed or applied:
- Files: [paths, or "none: review only"]
- Baseline: unchanged / proposed [run id], awaiting approval

## Unknowns and limits

- [What nobody decided or inspected]
- [What a run could not show]
