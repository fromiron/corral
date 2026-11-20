---
name: change-impact
description: "Finds the damage a change can do beyond its own diff and proves the single fact its safety depends on. Use when about to ship a small-looking change, when reviewing a diff you do not yet trust, or when asked what else a change affects."
license: MIT
---

# Change impact

A list of callers is cheap; any search produces one. The useful work is finding the damage a search does not reveal, and establishing the fact that keeps the change safe.

An assessment reads equally well whether it is right or wrong. So do not deliver an assessment alone. Deliver the fact and the evidence for it.

## Steps

1. **Understand the change.** What it adds, alters and removes. Then what behaves differently without the diff saying so: a default, an ordering, an error that used to be swallowed.
2. **Find the safety fact.** A change that looks risky is usually safe for one reason: "this only deletes entries nothing can reach", "every caller passes a non-empty list". Write that reason as a single sentence that could turn out false. If it is true, most of the worry goes with it. Spend your effort here before listing possibilities.
3. **Go past the search results.**
   - Data that outlives the code: stored records, files on disk, messages in a queue, a format another program reads.
   - Settings, switches and environment values.
   - Timing: start-up, shutdown, retries, the order in which asynchronous work finishes.
   - The library underneath: open the code of the exact version in use, and any local patch to it.
   - Code several calls away that depends on a side effect.
4. **Assess each risk plainly.** How it would break, where (file and line), how likely, how costly, how to check. Keep the ones you confirmed. List separately the ones you examined and ruled out.
5. **Establish the safety fact.** Write a short test or script that exercises the actual code path and stops with an error when the fact does not hold. Run it. If you cannot run it, trace it and label it traced.

## Rules

- Report only callers and interfaces you found in the code.
- A search with no results is a result. Say what you searched and where.
- If the safety fact is not established, write "not established". Do not soften it.

## Hand back

- **The change in plain terms.** Including what is not obvious from the diff.
- **The safety fact.** The sentence, whether it was run, traced or only read, and the evidence.
- **Open risks.** Each with how it breaks, where, likelihood, cost and the check.
- **Ruled out.** What you examined and why it is fine.
- **Check to run first.** The cheapest one that would catch a real problem, with any script you wrote.
