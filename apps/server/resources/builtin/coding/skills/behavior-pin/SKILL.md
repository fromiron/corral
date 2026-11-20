---
name: behavior-pin
description: "Records what the code does today, in a test, a snapshot or a saved baseline, before any structure moves, and then shows the behaviour did not change. Use when refactoring, renaming, moving code between modules, or replacing an implementation without changing what it does."
license: MIT
---

# Behaviour pin

A restructure alters how code is arranged and nothing about what it does. You can only say that afterwards if you recorded what it did beforehand.

## Steps

1. **Find out what callers rely on.** Follow the code from its entry points and note everything a caller can observe: results, errors, side effects, ordering.
2. **Record it before you move anything.** Write tests that capture present behaviour, or save the outputs for a representative set of inputs, including edge cases and failures. Capture what the code does now, oddities included. List the oddities; do not correct them here.
3. **Run the record against the untouched code.** It must pass. A record that has never passed fixes nothing in place.
4. **Describe where you are going.** The layout, types and call paths you intend, and what becomes simpler: which conditions, states or layers go away. If nothing becomes simpler, stop.
5. **Delete before rearranging.** Unreachable code, pass-through functions, repeated checks. Run the record.
6. **Rearrange a little at a time.** Run the record after each move. When it goes red, the cause is the move you just made.
7. **Change an interface in one sweep.** Switch every caller and remove the old interface together. Do not leave the old and new side by side.
8. **Search for renamed things as text.** Names also live in strings, documentation, settings and generated files, where a symbol search does not look.
9. **Compare old and new directly for a large move.** Feed both the same inputs and compare what comes out, or replay the saved baseline against the new code.

## Rules

- A successful compile and a clean lint run record nothing about behaviour.
- A bug or a gap you come across is a separate piece of work. Write it down and leave it. Once it is mixed in, "behaviour unchanged" is no longer true.
- If the record has to be edited to pass, behaviour changed. Say so plainly; the work has stopped being a restructure.
- If the code is not easier to follow somewhere when you finish, put it back.

## Hand back

- The record: what it covers and what it leaves uncovered.
- What moved and what was deleted.
- The evidence of sameness: the record's output before and after, or the comparison you ran.
- What you noticed and left alone.

The engineering-principles skill has the reasoning on reader load and on switching callers.
