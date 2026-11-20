---
name: root-cause
description: "Finds why something fails before fixing it: reproduce the failure, narrow the cause with evidence from the running system, and locate the first place it went wrong. Use when debugging a defect, a regression, a flaky test or any behavior that differs from what was expected."
license: MIT
---

# Root cause

A fix with no reproduced cause behind it is a guess. A guess that happens to work hides the bug until it comes back.

## Steps

1. **Reproduce it.** Use the surface where it was reported: the same command, screen, input and build. If it will not reproduce, narrow the conditions, construct the trigger, or add logging until it does. If you cannot run anything, follow the path by reading and label every conclusion as traced.
2. **Write down expected and observed.** Quote the exact output. A vague symptom leads to a vague cause.
3. **List the possible causes.** Beside each, name an observation that would rule it out.
4. **Halve the problem.** Make the observation that removes the most possibilities. Repeat. When you do not know what the program's state is, log it and read the log. Do not reason about what it "must" be.
5. **Stop when one mechanism is left** and you can switch the failure on and off at will.
6. **Walk back to the first wrong step.** Ask what caused each step, and stop only at a place where the code decided wrongly. Then ask whether the input or state that set it off is one the system is meant to accept. If it is, the code that broke must cope. If it is not, find what let it through.
7. **Look for relatives.** The same mistake tends to sit wherever the same pattern was copied.

## If you are also fixing it

- Ship only what the evidence calls for. A safeguard added just in case is untested speculation; leave it out.
- If a theory turns out wrong, undo the edits you made while following it.
- Confirm with the original reproduction, on the same surface. A green unit test covers the branch it exercises. Only the original reproduction shows the reported failure is gone.

## You are covering the bug up if you

Add a null check at the crash site, a retry, an empty catch, a clamp or a fallback default for a condition that should never arise. Each is a real fix only when the condition is a normal one.

## Hand back

- The reproduction: steps and exact output.
- The cause, with file references, and the evidence that sets it apart from the other possibilities.
- What you ruled out and how.
- If fixed: the output of the same reproduction before and after.
- What you could not reproduce or check.
- If the cause was slow to find, what would have exposed it quickly: a log line or an assertion that is always on.
