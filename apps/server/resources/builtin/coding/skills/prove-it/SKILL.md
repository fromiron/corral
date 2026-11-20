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
6. **Repeat after every edit.** What you observed before a file changed says nothing about the file now.
7. **Make it repeatable where you can.** A command or script that someone else can run again.

## Label every claim

- **Ran.** You executed the real code and have its output. Seeing it in the running product is the strongest form.
- **Traced.** You followed the path step by step by reading, and the bad case cannot be reached.
- **Read.** You can point at the line that does it. You did not follow what leads there.
- **Not checked.** Say so.

For each criterion, aim for the strongest label you can reach at reasonable cost. Write the label beside the result.

## These are not observations of the result

A clean build. A changed file. A run from before the last edit. The author's own summary. Output served from a cache. A passing test that does not touch the change.

## Verdict

- **Pass** when every required criterion is labelled ran. Where running is impossible, traced may stand in, and you say so.
- **Revise** when a criterion is unmet. Name it and show the output.
- **Inconclusive** when you could not check. A pending, failed, cancelled or timed-out check is never a pass.

## Hand back

For each criterion: the observation, its result and its label. Then what you did not check and why.
