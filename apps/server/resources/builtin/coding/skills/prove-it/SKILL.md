---
name: prove-it
description: "Verifies finished work against the real artifact instead of a proxy, and reports for each claim whether it was run, traced, read or not checked. Use when a change is complete and before saying it is done, when verifying someone else's work against criteria, or when a result has only been claimed."
license: MIT
---

# Prove it

"Done" is a statement about the real thing: the current files, the running program, the actual output. Check that thing.

## Steps

1. **Name what you are checking.** Which tree, build or version. Then turn each criterion into something you can observe: this command prints that, this screen shows that.
2. **Choose the most direct observation for each criterion.** Use the feature. Print the value. Call the endpoint. Read the diff line by line.
3. **Make the observations and keep the output.**
4. **Cover the whole changed path.** Callers, error handling and the failure cases, as well as the main case.
5. **Doubt a surprising failure.** Confirm the check looked at the right build and the right data before concluding the work is wrong.
6. **Repeat what an edit could have changed.** An observation made before a file changed says nothing about that file now.
7. **Make it repeatable where you can.** A command or script that someone else can run again.

## Label every claim

- **Ran.** Output from executing the current code.
- **Traced.** A step-by-step reading from input to outcome, with file references.
- **Read.** The line that does it, without the path to it.
- **Not checked.** Say so.

For each criterion, aim for the strongest label you can reach at reasonable cost. Write the label beside the result.

## These are not observations of the result

A clean build. A changed file. A run from before the last edit. The author's own summary. Output served from a cache. A passing test that does not touch the change.

## Verdict

- **Pass** when every required criterion is met and labeled ran, or traced where it cannot be run. Say which.
- **Revise** when a criterion is unmet. Name it and show the output or the trace.
- **Inconclusive** when a criterion could be neither run nor traced, or a check is pending, was cancelled, timed out or is unclear.

## Hand back

For each criterion: the observation, its result and its label. Then what you did not check and why.
