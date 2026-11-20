---
name: shape-first
description: "Settles the shape of a change before any code is written: the data it carries, the types and signatures at each boundary, and which module owns what. Use when a change crosses a function or module boundary, adds a type or a piece of state, or when writing code now would fix a structure in place that nobody chose."
license: MIT
---

# Shape first

Code written before its shape is decided keeps the first shape that compiled. Decide on paper, where changing your mind costs nothing.

## Steps

1. **Read what the change touches.** The callers, the data going in and out, and every place that writes the state involved. List them with file references. Do not design against code you have not opened.
2. **Write the caller's side first.** Show how the new code will be used: the call, its arguments, what comes back, what can go wrong. If using it is awkward, the design is wrong however neat the inside looks.
3. **Name the data.** Write the records and types the change adds or alters. List the states each can be in, and the combinations that must never occur.
4. **Draw two candidates.** They must disagree about something real: where the state lives, who calls whom, what the boundary exposes. Give signatures and module layout only. No function bodies.
5. **Choose.** Prefer the candidate with a single writer for every piece of state, a single route to every outcome, and the narrowest surface for callers. Say which of the three settled it.
6. **Order the build.** Split the work into steps that each end in something you can check. Whatever the rest depends on goes first.

## Go back when

- A candidate needs the same special case in two places. It does not fit; return to step 3.
- The two candidates are one idea under two names. Find a second idea, or say there is only one.
- The chosen design needs a note explaining how to call it. Change the design.

Skip this skill when the request stays inside one function. Say so in a line.

## Hand back

- The goal in one sentence.
- What the change touches, with file references.
- The usage sketch.
- The chosen design: data, signatures, which module owns what.
- The candidate you rejected and why.
- The build steps in order, each with its check.
- Assumptions and open questions.

The engineering-principles skill holds the reasoning behind these choices. When several finished candidates already exist, use the pick-and-graft skill to choose among them.
