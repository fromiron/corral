---
name: behavior-pin
description: "Records what the code does today, in a test, a snapshot or a saved baseline, before the restructure starts, and then shows the behavior did not change. Use when refactoring, renaming, moving code between modules, or replacing an implementation without changing what it does."
license: MIT
---

# Behavior pin

A restructure alters how code is arranged and nothing about what it does. You can only say that afterwards if you recorded what it did beforehand.

## Steps

1. **Find out what callers rely on.** Follow the code from its entry points and note everything a caller can observe: results, errors, side effects, ordering.
2. **Make the record.** Tests that capture present behavior, or saved outputs for a representative set of inputs, including edge cases and failures. Capture what the code does now, oddities included. List the oddities; do not correct them here.
3. **See the record pass on the untouched code.** A record that has never passed fixes nothing in place. If you cannot run anything, say so: the record is then not run, and any later claim of sameness is traced.
4. **Plan the moves.** List them in order, deletions first, and say what each one lets a reader stop tracking.
5. **Make one move, run the record, repeat.** When it goes red, the cause is the move you just made.
6. **Finish each move.** Nothing keeps the old name or the old interface: callers, strings, settings, documentation, generated files. Search for the old name as text; a symbol search does not look in all of those.
7. **For a large move, compare outputs.** Run the saved inputs through the new code and compare with what was saved.

## Rules

- A successful compile and a clean lint run record nothing about behavior.
- A bug or a gap you come across is a separate piece of work. Write it down and leave it. Once it is mixed in, "behavior unchanged" is no longer true.
- If the record has to be edited to pass, behavior changed. Say so plainly; the work has stopped being a restructure.
- If the restructure was your own idea and no move on your list lets a reader stop tracking something, do not start it. If it was asked for, do it, and say what it did and did not simplify.

## Hand back

- The record: what it covers, what it leaves uncovered, and whether it was run.
- What moved and what was deleted.
- The evidence of sameness: the record's output before and after, or the comparison you ran.
- What you noticed and left alone.

The engineering-principles skill has the reasoning on reader load and on switching callers.
