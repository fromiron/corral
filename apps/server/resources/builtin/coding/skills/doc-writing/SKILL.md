---
name: doc-writing
description: "Writes technical documents that do one job for one reader: a tutorial, a how-to, a reference page, an explanation, a change description or a commit message. Use when asked to write or revise a README, a guide, an API page, a design note, release notes, a pull request description or a commit message."
license: MIT
---

# Doc writing

A document fails when it tries to teach, instruct, list and justify all at once. Pick one job, and write for the person who has that job to do.

## Steps

1. **Name the reader and the job.** Who opens this, and what do they need to walk away able to do? Choose one kind:
   - Reference: someone looks up an exact fact and leaves.
   - How-to: someone who knows the basics completes a specific task.
   - Tutorial: a beginner follows it once and ends with something working.
   - Explanation: someone wants to understand why it is built this way.
   Material that belongs to another kind goes in another document. Link to it.
2. **Collect the facts before the wording.** Read the code, open the sources, and run the commands if you can. Do not document behavior you assume.
3. **Put the answer at the top.** The first screen says what this is, who it is for and what they get.
4. **Shape it to the job.** Numbered steps for a procedure, with one action in each. A table for facts that share columns. Paragraphs for reasoning.
5. **Write the sentences.** Settle on one term for each thing, define it where it first appears and do not vary it. Say who does what, in the present tense. Keep idiom and wordplay out; many readers translate.
6. **Use real examples.** The smallest one that runs. Show the command and the output it gives. Never a placeholder the reader must decode.
7. **Test it.** Follow your own steps on a clean start if you can run commands. Open every link. If you could not, say which parts are untested.

## A change description

Write it in this order: the problem that prompted the change; what the change does; how it was checked, with the command and the result; what it costs or puts at risk; what was left out on purpose.

## A commit message

Follow the project's commit convention if it has one. Otherwise the subject line is an instruction that says what the commit does, in about fifty characters: "Reject empty team names". The body says why the change was needed and anything a future reader could not work out from the diff. Do not narrate the diff.

## Rules

- Do not describe what the software will do one day. Describe what it does.
- Do not pad a reference page with tutorial prose, or a tutorial with every option.
- Keep the document's existing terms and voice when revising.
- Screens, logs and examples must not contain secrets, keys or private paths.

## Hand back

The document, the kind you chose and for whom, and the parts you could not verify.

For sentence-level tightening, see the plain-prose skill.
