---
name: pick-and-graft
description: "Compares several independent answers to the same task against fixed criteria, picks one as the base and carries over the best parts of the others. Use when judging parallel attempts at a design, an implementation, a review or a document, or when merging several reports of findings into one."
license: MIT
---

# Pick and graft

Several attempts at one task rarely contain one that is best in every respect. They also should not be blended: an average of three designs is a fourth design nobody thought through. Choose one to stand on, then take from the others what is plainly better.

## Steps

1. **Fix the task and the criteria before you read.** Restate the task in a sentence. Write three to six criteria you could mark as met or not met: correctness against the request, behaviour at the edges, how much it changes, how easy it is to extend, what evidence comes with it. Take them from the request. Do not derive them from whichever candidate you read first.
2. **Read every candidate in full.** Do not stop at the first good one.
3. **Mark each candidate against each criterion.** Cite the place in the candidate that earns the mark. A candidate's statement that it works is not evidence. A command with its output is. If you can run commands and the candidates can be run, run the same check on each.
4. **Choose the base.** Pick the one the next person can build on most safely. That is usually the candidate that is correct with the least surface, which may not be the most complete. On a tie, take the smaller one.
5. **Graft.** From each other candidate, take at most one or two things the base lacks: a case it missed, a clearer name, a check, a better paragraph. Rework each into the base's own terms and structure. Do not paste it in unchanged.
6. **Check the combined result as a whole.** A graft can contradict the base. Reread it, or rerun the checks.

## Reading the spread

- **Candidates agree.** A good sign for the shared part. Verify it once and spend your attention on the differences.
- **Candidates diverge widely.** The task was probably underspecified. Say what was missing from the request. Do not settle it by averaging.

## Merging findings

When the candidates are reports of problems:

- Keep a finding that comes with a run or a step-by-step trace.
- Merge findings that have the same cause, and keep the clearest reproduction.
- List what you dropped, with the reason: no evidence, a duplicate, or outside the task.
- A finding raised by one reviewer alone is not weaker for that. Judge the evidence, not the count.

## Rules

- Do not build a compromise that no candidate proposed.
- Do not reward length or confidence.
- Do not hide which candidate each part came from.

## Hand back

- The criteria.
- A table of candidates against criteria, with a reference for each mark.
- The base, and why.
- Each graft and where it came from.
- What you rejected, and why.
- The combined result.
- What remains unverified.
