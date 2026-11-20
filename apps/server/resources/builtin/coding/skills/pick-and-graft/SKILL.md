---
name: pick-and-graft
description: "Compares several independent answers to the same task against criteria fixed in advance, stands the result on one of them and brings in the better parts of the others. Use when judging parallel attempts at a design, an implementation, a review or a document, or when merging several reports of findings into one."
license: MIT
---

# Pick and graft

Several attempts at one task rarely include one that is best in every respect. Blending them is worse: the average of three designs is a fourth design that nobody thought through. Stand on one attempt and borrow from the rest.

## Before you read

Restate the task in a sentence. Then write down a handful of criteria, each one something you could mark met or not met: does it do what was asked, how does it behave at the edges, how much does it change, how easily can it be extended, what evidence comes with it. Take the criteria from the request. If you write them after reading, the first candidate you liked will have written them for you.

## Mark the candidates

1. Read every candidate to the end, including the ones that start badly.
2. Mark each candidate against each criterion. Beside every mark, cite the place in the candidate that earned it.
3. Do not accept a candidate's word about itself. "Tested and working" is a claim. A command with its output is evidence.
4. If you can run commands and the candidates can be run, put the same check to each of them.

## Read the spread before you choose

- **They agree.** The shared part is probably right. Verify it once, then give your attention to where they differ.
- **They differ in detail.** This is the normal case. Carry on.
- **They differ in kind.** The request left something open, and each candidate filled it in differently. Name what was left open and hand that back. Merging answers to different questions produces an answer to none of them.

## Build the result

1. **Choose what to stand on.** Prefer the candidate that is correct and gives the next person the least to keep track of. It is often not the most complete one. When two are level, take the smaller.
2. **Borrow sparingly.** From each of the others, take only what the base plainly lacks: a case it missed, a clearer name, a check, a better paragraph. If you are importing most of another candidate, you chose the wrong base.
3. **Rewrite what you borrow** in the base's own terms and structure, so the result reads as one author's work.
4. **Check the whole.** A borrowed part can contradict the base. Reread the result from the top, or run the checks again.

## When the candidates are findings

- There is no base to stand on. The result is the merged list.
- Keep a finding that comes with a run or a step-by-step trace.
- Where several findings come from one cause, combine them and keep the clearest reproduction.
- A finding only one candidate raised is not weaker for that. Weigh the evidence and ignore the count.
- Record each finding you drop and the reason: no evidence, a duplicate, or outside the task.

## Rules

- Do not build a compromise that no candidate proposed.
- Do not reward length or confidence.
- Do not hide where a part came from.

## Hand back

- The combined result.
- Provenance: which candidate it stands on, and which parts came from which others.
- The marks: candidates against criteria, with the reference for each.
- What you set aside from each candidate, and why.
- What the spread told you about the request.
- What is still unverified.
