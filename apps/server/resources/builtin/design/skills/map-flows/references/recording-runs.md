# Recording runs

Read this file when the client can operate the product and a run will be
recorded. Without runtime access, do not record a run: keep the evidence
static and say that nothing was executed.

## Before the walk

1. Validate the map. A run can only cite transitions the map contains.
2. Choose the journey and scenario, and note how the scenario's starting facts
   are produced: a guest session, a simulated lost connection, an empty field.
3. Fix the conditions and write them down: revision, target, viewport, input
   method, locale. Use the tool the client already provides, such as a browser
   automation tool, the project's end-to-end tests, or a person operating the
   product. No particular tool is required.
4. Use test accounts and test data. Do not perform purchases, deletions, or
   messages against real accounts, and stop before an action that cannot be
   undone unless the user approved it for this environment.

## During the walk

Start at the journey's entry state and follow one route. For each step:

1. perform the transition's action with the declared input method;
2. read where the product is from what it shows, such as the address, the
   heading, an open dialog, or a visible message, not from what the action was
   meant to do;
3. record the result and what you saw:

```json
{"transition": "workout.add-set", "result": "blocked", "landed": "workout",
 "evidence": "Tab did not reach the Add set control in 30 presses; the screen still shows “Active workout”."}
```

A keyboard run uses only the keyboard: move focus with Tab and activate with
Enter or Space. A control that cannot receive focus is `blocked`, even when a
click would work. Keyboard operation in a browser is not a screen reader test;
say so in `limitations`.

When an action lands somewhere the map does not expect, record `diverged` with
the real `landed` state, then update the map: the discovered path becomes a
transition with intent `none`. When you perform an action the map lacks,
record it as `unmapped`.

Stop the run when the route cannot continue, and record the outcome honestly:
`success` only on a success state with the success condition confirmed.

## After the walk

- Save the run as a new file. Do not edit earlier runs.
- Validate the map again so the run's continuity is checked.
- Mask credentials, tokens, and personal data in targets and evidence text.
- List in `limitations` what the run cannot show: a simulated condition, a
  single viewport, no assistive technology, a fixture instead of production.

A run is evidence for the revision and conditions it records. After the
product changes, earlier runs are history; record a new run before calling the
changed flow verified.
