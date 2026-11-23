# Analysis and comparison

Read this file when interpreting the output of `analyze_flow.py` or
`compare_flows.py`, or when handing a finding to another skill.

## What is computed

For each journey and scenario the analysis searches every combination of state
and facts reachable from the entry. It does this twice:

- **intended** — approved and proposed transitions only: what the design
  allows;
- **as-built** — transitions a run reached, plus observed or inferred ones no
  run contradicts: what the product allows as far as the evidence goes.

A layer is `null` when it has no transitions: nothing designed, or nothing
built yet.

| Result | Definition | Read it as |
|---|---|---|
| `meets_expectation` | The expected end, success or a way out, is reachable | A route exists in that layer. On the intended layer it says nothing about the product |
| `route` | The route with the fewest user actions | One route, not the route people take |
| `user_actions`, `inputs`, `screens` | Counts along that route | Effort, reported separately and never summed. Fewer is not automatically better: a confirmation step adds an action on purpose |
| `route_evidence` | Evidence states along the route | How much of the route a run has verified |
| `mandatory_transitions` | Steps on every route to the expected end | Where discoverability matters most, because there is no way around them |
| `unavailable_transitions` | Actions whose conditions never hold in this scenario | Expected for the other branch of a condition; a finding when the person has no alternative |
| `dead_ends` | Reached states with no route to success or to a way out | The person is stuck. Also covers loops with no way out |
| `failure_states` | Each reached failure: `recoverable`, `exit-only`, or `trapped` | Whether the person can still reach the goal after the failure |

`parity` uses the vocabulary of `review-components` for approved transitions:
`aligned` when a run reached it, `drift` when the latest run was blocked or
diverged, `unknown` when there is static evidence and no run, and
`not-inspected` when there is no evidence.

With `--revision`, evidence gathered at another revision is marked stale. Stale
evidence still shows what was true then; it does not show what is true now.

## Signals and who judges them

Signals are findings, ordered with broken behavior first. Raise them on the
as-built layer when it exists.

| Signal | Meaning | Hand to |
|---|---|---|
| `goal-unreachable` | No route reaches the goal. `designed: true` means the design does and the product does not | Report it; fix on request |
| `exit-missing` | A scenario that should end in a way out has none | Report it |
| `dead-end` | States with no way on and no way out | `plan-structure` when navigation is missing |
| `failure-without-recovery` | A failure the person cannot recover from | `review-components` for the error state's contract |
| `run-drift` | The latest run was blocked or diverged | `check-accessibility` when keyboard or assistive technology failed where another input worked |
| `guard-not-enforced` | A run passed a step whose condition was unmet | Correct the product or the map |
| `mandatory-step-not-persistent` | An unavoidable step of a critical journey is contextual or disclosed | `review-components` to judge visibility and disclosure cost |
| `critical-route-unverified` | Steps of a critical route no run has reached | `verify-changes` |
| `unmapped-step` | A run performed an action missing from the map | Add it to the map with intent `none` |
| `unplanned-path` | Paths without a design decision | The owner approves or removes them |
| `awaiting-approval` | Proposed transitions | The owner |
| `stale-evidence` | Evidence from another revision | `verify-changes`; record a new run |

Pass the transition ids, the journey and scenario, and the evidence state with
each handoff. Do not judge another skill's question here: this skill reports
that an unavoidable step sits in a menu; `review-components` decides whether
that is acceptable.

## Comparison

`compare_flows.py` compares two maps of the same flow and the runs recorded
against each. It names a **regression** only where something that worked
stopped working:

- the expected end became unreachable;
- a state became a dead end;
- a failure lost its recovery;
- a transition a run used to reach is now blocked or diverged;
- a run that ended in success no longer does.

The reverse cases are **improvements**. Everything else is a **change**: more
or fewer actions, a different route, different unavoidable steps, added or
removed states and transitions. A change needs a person's judgment and is
never counted as a gain or a loss.

Run results are compared only under the same input method and viewport, and
`not_compared` lists what had no counterpart. `no-regression` means none of the
kinds above occurred. It is not a release decision and not a usability result.

To compare with an earlier commit in the same store, restore the earlier map
to a temporary file and select runs by revision:

```bash
git show <earlier>:ux-flows/checkout.flow.json > /tmp/before.flow.json
python scripts/compare_flows.py /tmp/before.flow.json ux-flows/checkout.flow.json \
  --before-runs ux-flows/runs --before-revision <earlier> --after-revision <later>
```

## Limits to state in every report

- The map is a model written by a person or an agent; it can be wrong or
  incomplete, and an unmodeled path is invisible to the analysis.
- A run shows one execution under its recorded conditions.
- None of this measures comprehension, discoverability, satisfaction, or
  conversion.
