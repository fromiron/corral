---
name: smallest-change
description: "Makes the smallest change that fully solves the request while keeping callers, error handling and tests intact. Use when implementing a feature, a fix or a restructure, when sizing a diff, or when tempted to add an option, a wrapper or a cleanup nobody asked for."
license: MIT
---

# Smallest change

The smallest change is the one with the fewest things a reviewer has to take on trust. It is not the one with the least typing, and it never leaves out part of what was asked.

## Steps

1. **Restate the request.** One sentence for the goal. A second for the least you could change to reach it. If you cannot write the second sentence, you do not understand the request yet.
2. **Read before writing.** Open the code you will change and everything that depends on it: callers, exports, tests, fixtures, configuration. List what has to change together.
3. **Look for something to remove.** An unreachable branch, a duplicate helper, a check made twice. Removing first often shrinks the change.
4. **Reuse in this order.** The pattern the project already uses. Then what the language or platform provides. Then a dependency that is already installed. Add a new dependency only for a substantial problem, never for a few lines.
5. **Decide once.** When several places need the same answer, work it out in one spot and hand them the value.
6. **Write it** in the style and naming of the code around it.
7. **Read your own diff.** Every hunk must trace back to the request. Revert the ones that do not.

## Not part of the change

- An option or parameter that nothing passes.
- A wrapper with one caller.
- A general framework for a single case.
- Tidying of code the request does not touch.
- A compatibility layer for code you are free to edit.
- Comments that narrate the change.

## Always part of the change

- The validation, error handling, cancellation and cleanup the old code had.
- Accessibility and user data.
- Every part of the request. A shorter diff is no reason to put off something that was asked for.
- One meaningful test for behavior that is not trivial. See the failing-test-first skill.

## Hand back

- What changed and why, by file.
- What you left out on purpose.
- What you checked and how. See the prove-it skill.
- Anything in the request you could not do, and why.
