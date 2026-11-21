---
name: change-impact
description: "Finds the damage a change can do beyond its own diff and tests the one assumption its safety depends on. Use when asked what else a change affects, or before shipping a change to shared code, stored data or an interface."
license: MIT
---

# Change impact

Review already covers what a diff and its callers show. This skill covers the rest: the one assumption the change leans on, and the places a search does not look.

## Steps

1. **State the assumption.** A change that looks risky is usually safe for one reason: "this only deletes entries nothing can reach", "every caller passes a non-empty list". Write that reason as one sentence that can be false. If you cannot write it, you do not yet know why the change is safe; read until you can.
2. **Test it first.** A short script or test on the real code path that fails when the assumption is false. Run it. If you cannot run it, trace the path and label the result traced. If your role may not change files, keep the script out of the working copy and put its text in your report.
3. **Look where a search does not.**
   - Behavior the diff changes without saying so: a default, an ordering, an error that used to be swallowed.
   - Data that outlives the code: stored records, files on disk, messages in a queue, a format another program reads.
   - Settings, switches and environment values.
   - Timing: start-up, shutdown, retries, the order in which asynchronous work finishes.
   - The library underneath: open the code of the exact version in use, and any local patch to it.
   - Code several calls away that depends on a side effect.
4. **Sort what you found** into confirmed, ruled out and not established. For a confirmed risk, say where it breaks (file and line) and how to check it.

## Rules

- Report only callers and interfaces you found in the code.
- A search with no results is a result. Say what you searched and where.
- An assumption you could not test is "not established". Do not soften it.

## Hand back

The assumption, its status (ran, traced or not established) and the evidence. Confirmed risks, each with where it breaks and how to check. What you ruled out and why. The first check to run: the cheapest one that would catch a real problem, with any script you wrote.
