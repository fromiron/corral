---
name: engineering-principles
description: "An index of eighteen engineering principles, each with the situation that calls for it and a reference file holding the full rule. Use when designing, building, restructuring, debugging or reviewing code and a judgment call comes up: how to hold the data, how small to keep a change, where a check belongs, whether a fix is real, or whether a figure can be trusted."
license: MIT
---

# Engineering principles

Each entry gives a principle and the situation that calls for it. When the situation matches your work, open that principle's file under `references/` and follow it. Open only the ones you need.

When a principle decides something for you, say so in your report: which one, and what you did differently because of it. Mention only those whose reference you opened.

## Shape

- **Data shape first.** You are about to add behaviour or state and have not yet decided how the data is held. [references/data-shape-first.md](references/data-shape-first.md). Procedure: the shape-first skill.
- **Redesign, don't bolt on.** Something new is being asked of code that was not built for it. [references/redesign-dont-bolt-on.md](references/redesign-dont-bolt-on.md)
- **Subtract first.** The area you are about to extend contains leftovers. [references/subtract-first.md](references/subtract-first.md). Procedure: the smallest-change skill.
- **One owner.** Two parts of the system change the same value, or there are two ways to reach one outcome. [references/one-owner.md](references/one-owner.md)
- **Reader load.** Answering a simple question about the code takes several files. [references/reader-load.md](references/reader-load.md)

## Boundaries

- **Guards at the edges.** Input from outside the program is being handled, or the same check appears at several depths. [references/guards-at-the-edges.md](references/guards-at-the-edges.md)
- **No illegal states.** A structure allows combinations of values that must never occur. [references/no-illegal-states.md](references/no-illegal-states.md)
- **Idempotent steps.** An operation may be repeated or cut short: a retry, a restart, a duplicate request. [references/idempotent-steps.md](references/idempotent-steps.md)
- **Migrate and delete.** An interface inside the codebase is being superseded. [references/migrate-and-delete.md](references/migrate-and-delete.md)

## Proof

- **The real artifact.** You are about to report that something works. [references/the-real-artifact.md](references/the-real-artifact.md). Procedure: the prove-it skill.
- **The first wrong step.** A failure has been found and the nearest fix is a check at the point of failure. [references/the-first-wrong-step.md](references/the-first-wrong-step.md). Procedure: the root-cause skill.
- **Behaviour, not internals.** A test is being added, edited or questioned. [references/behaviour-not-internals.md](references/behaviour-not-internals.md). Procedures: the failing-test-first and behavior-pin skills.
- **No figure without its cause.** A figure is about to be quoted or used to decide something. [references/no-figure-without-cause.md](references/no-figure-without-cause.md). Procedure: the measure-first skill.
- **Verifiable units.** The task is too big to confirm in one go, or repeats one edit many times. [references/verifiable-units.md](references/verifiable-units.md)
- **Question the premise.** A second attempt has failed in the same way as the first. [references/question-the-premise.md](references/question-the-premise.md)

## Leverage

- **Rule in structure.** The same mistake has been corrected before. [references/rule-in-structure.md](references/rule-in-structure.md)
- **Tool over toil.** The job is the same action many times, or a claim about many places. [references/tool-over-toil.md](references/tool-over-toil.md)
- **Compare before committing.** The codebase has no existing answer for the choice in front of you. [references/compare-before-committing.md](references/compare-before-committing.md). Procedure: the pick-and-graft skill.

## When two principles disagree

The smallest change and the right shape can point in different directions. Take the right shape when the requirement is permanent and the current structure works against it. Take the smallest change when the requirement is narrow or the structure already fits. Say which you took and why.
