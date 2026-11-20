# Tool over toil

**Rule.** When work is large, repetitive or has to be proven, write the program that does it or demonstrates it, and hand that over with the result.

**In practice**

- Many similar edits: express the edit as a transformation, apply it, then inspect a sample and the overall pattern of the diff. Manual repetition invites one slip per file.
- A statement about the whole codebase ("nothing calls this with an empty list"): write the query that establishes it and attach its output.
- Old behavior against new: a script that feeds both the same inputs and reports the differences.
- A question you expect to be asked again: keep the script that answers it.

**Keep it modest.** A tool for one job can be a dozen lines. Delete it afterwards unless it will be reused, and say how to run it either way.

**Why it matters.** Someone else can rerun a program. Nobody can rerun your attention.
