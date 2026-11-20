---
name: trace-the-code
description: "Explains how a part of a codebase works by following the real code path, with a file reference for every claim. Use when asked how something works, when getting oriented in an unfamiliar subsystem, or before designing a change to code you have not read."
license: MIT
---

# Trace the code

An explanation built from names and folder layout is a guess about the code. Follow one real path through it and explain what you saw.

## Steps

1. **Fix the question.** What does the reader want to be able to do afterwards? That sets the scope. Say what is outside it.
2. **Find the ways in.** Where a request, an event, a command or a call enters this part of the system.
3. **Follow one concrete case from start to finish.** Pick a real input. At each hop note the function, what it reads, what it writes and what it passes on, with a file reference.
4. **Follow the variations that matter.** The error path. Cancellation. A retry. A second caller that uses it differently.
5. **Place the pieces.** For each module: what it is responsible for, what data crosses its boundary, and who writes each piece of state.
6. **Read the tests and the settings.** They show behavior the main path hides: defaults, limits, switches.
7. **Mark what you did not open.** If a statement rests on a file you did not read, write "not read" beside it.

## Write it up

- **Purpose.** Two to four sentences: what this part is for and how it goes about it.
- **Vocabulary.** The terms the code uses, a line each.
- **The path.** The case you followed, in order, with file references.
- **Map.** A short table of path and responsibility.
- **Surprises.** Hidden ordering, unexpected defaults, code that looks wrong and is depended on.

## Rules

- Every statement has a file reference or is labeled inferred.
- Describe what the code does now. Why it does so is a separate question; see the ask-the-record skill.
- Do not go line by line. A reader should finish in a few minutes and know where to look next.
- Do not change files.

## Hand back

The write-up, the question it answers, and the parts you did not read.
