# Flow model

Read this file when writing or editing a flow map or a run. The schemas in
`assets/` list every field; this file says how to model with them.

## One file, one graph

A flow map is one JSON file named `<name>.flow.json`. It holds one graph and
the journeys that cross it. Split maps by product area, such as checkout or
onboarding, so a session loads only the area it works on. Use an `external`
state where a journey continues in another map.

| Part | What it records |
|---|---|
| `facts` | Boolean conditions the product depends on: `signed-in`, `offline`, `cart-empty` |
| `states` | Where the person can be: a screen, an overlay, an inline state, or an external surface |
| `transitions` | One action by the person or the system that moves from one state to another |
| `journeys` | A user, a goal, a success condition, an entry state, and the states that count as success |
| `unknowns` | What nobody has decided or inspected |

## States

- `screen` — a full view or route.
- `overlay` — a dialog, sheet, or menu on top of a screen.
- `inline` — a change within the same view: a validation error, a loading or
  empty state, a failed save.
- `external` — outside the product or the map: a payment provider, an email
  link, another flow map.

Give a state `"role": "failure"` when the person did not want to arrive there.
Entry, success, and ways out belong to the journey, because one journey's goal
can be another journey's detour.

Model a state when the available actions differ. Two visual variants of the
same screen with the same actions are one state.

## Transitions

Name the action by what the person does: `Activate “Save set”`, not
`POST /sets`. Use `"actor": "system"` for a step the person does not perform,
such as a redirect or a connection returning. System steps cost no user action.

- `requires` lists the conditions that must hold. Every literal must be true;
  write a second transition for an alternative. Prefix a fact with `!` to
  require it false.
- `effects` lists what the action changes: `["signed-in"]` after sign-in,
  `["!offline"]` when the connection returns.
- `inputs` counts the fields or choices the action asks for.
- `visibility` says how the control is offered in the state the transition
  starts from, in the vocabulary `review-components` uses: `persistent`,
  `contextual`, or `disclosed`. Mark an action `disclosed` when it is available
  only after opening a menu, panel, or details control, whether or not that
  container is modeled as its own state. The fourth value of that vocabulary,
  unavailable, is not written here: an action is unavailable when its
  `requires` is unmet in a scenario or a run records it as `blocked`.

Branches that share a control are separate transitions with opposite
conditions, for example `save` with `!offline` and `save-offline` with
`offline`.

### Recovery needs an effect

A failure is recoverable only when something clears its cause. Model the
cause as a fact and the recovery as a transition whose effect removes it, or
as a system step for a cause the person cannot fix:

```json
{"id": "save-failed.reconnect", "from": "save-failed", "to": "save-failed",
 "action": "The connection returns", "actor": "system", "effects": ["!offline"]}
{"id": "save-failed.retry", "from": "save-failed", "to": "summary",
 "action": "Activate “Try again”", "actor": "user", "requires": ["!offline"]}
```

Without the effect the analysis reports, correctly, that nothing in the map
ever ends the failure.

## Intent and evidence

Each transition has both; see the two-layer rule in `SKILL.md`.

- A design under way: `intent` is `approved` or `proposed`, and evidence is
  `{"state": "unknown"}` with a `note` when something is known to be missing.
- A product read from code or screens: evidence is `observed` or `inferred`
  with `source`, `ref`, and the `revision` inspected. Sources are `design`,
  `documentation`, `code`, `screenshot`, and `live`.
- A path nobody designed: `intent` is `none`. It must have observed or
  inferred evidence; a path with neither intent nor evidence is invented and
  the validator rejects it.

When the owner approves a path the product already has, change its intent to
`approved`. When a proposal is rejected, remove it.

## Journeys and scenarios

A journey names the `user`, the `goal`, an observable `success_condition`, the
`entry` state, and the `success` states. List in `exits` the states where a
person leaves on purpose, such as a cancelled order or another journey's goal;
otherwise those states are reported as dead ends.

`start_facts` are true when the journey begins. A scenario changes them to ask
"what if": a guest instead of a member, a declined card, an empty form field.
The scenario named `default` always exists and uses `start_facts` alone. Set
`"expect": "exit"` on a scenario where the right outcome is a way out, such as
an ineligible applicant.

Mark a journey `critical` when the product fails its purpose if the journey
fails. Critical journeys get stricter findings.

## Runs

A run is one continuous walk through a journey in the running product, from
the entry state, stored as `runs/<name>.run.json`. Each step names a
transition and one result:

| Result | Meaning |
|---|---|
| `reached` | The action was performed and the product landed on the declared state |
| `diverged` | The action was performed and the product landed somewhere else; record where in `landed` |
| `blocked` | The action could not be performed: the control is missing, disabled, or out of reach for this input |
| `unmapped` | An action the map does not contain was performed; give `from`, `action`, and `landed`, then add the transition to the map |

Every step states in `evidence` what was seen. A run records the revision, the
method and tool, the target, the viewport, and the input method, because a
result holds only under those conditions. To test another branch or another
input method, record another run.

The outcome is `success` only when the run ends on a success state, and
`success_evidence` says how the success condition was confirmed.
