---
name: root-cause
description: "Finds why something fails before fixing it: reproduce the failure, narrow the cause with evidence from the running system, and locate the first place it went wrong. Use when debugging a defect, a regression, a flaky test or any behavior that differs from what was expected."
license: MIT
---

# Root cause

A fix with no reproduced cause behind it is a guess. A guess that happens to work hides the bug until it comes back.

## Steps

1. **Reproduce it** where it was reported: the same command, screen, input and build. If it will not reproduce, change one condition at a time (input, build, timing, data) until it does, and note which one mattered. If it still will not reproduce, say so and label the cause unconfirmed. If you cannot run anything, follow the path by reading and label every conclusion traced.
2. **Write down expected and observed.** Quote the exact output. A vague symptom leads to a vague cause.
3. **List the possible causes.** Beside each, name an observation that would rule it out.
4. **Narrow.** Pick the check that splits the remaining causes most evenly, run it, and cross off what it excludes. Take the program's state from its output; do not reason about what it "must" be. Repeat until one mechanism is left and you can switch the failure on and off at will.
5. **Find where it first went wrong.** From the failure, ask what caused each step, and stop at code that decided wrongly. Then ask whether the input or state that set it off is one the system is meant to accept. If it is, that code must cope. If it is not, the fault is whatever let it through.
6. **Search for the same mistake elsewhere.** It tends to sit wherever the pattern was copied.

## If you are also fixing it

- Each line of the fix answers something you observed. Edits made for a theory that failed come out.
- A check, retry or default added at the point of failure repairs nothing unless the condition it absorbs is a normal one. For any other condition it hides the fault.
- Confirm where the failure was reported, with the same steps. Nothing else shows the reported failure is gone.

## Hand back

- The reproduction: steps and exact output.
- The cause, with file references, and the evidence that sets it apart from the other possibilities.
- What you ruled out and how.
- If fixed: the output of the same reproduction before and after.
- What you could not reproduce or check.
- If the cause took long to find, what would have made it visible earlier.
