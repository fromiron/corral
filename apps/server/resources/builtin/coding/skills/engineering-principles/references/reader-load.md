# Reader load

**Rule.** Judge code by how much a reader has to keep in mind to answer a question about it, and reduce that.

**In practice**

- Pick a question a maintainer would ask, such as where a value is set. Count the files and jumps needed to answer it. Remove the jumps that add nothing.
- Look for things a reader must remember instead of see: a variable changed far from where it is read, a flag whose meaning depends on an earlier call, steps that only work in one order. Bring cause and effect together.
- A function used once whose name says no more than its body: fold it back in.
- Use the words of the problem (invoice, session, retry) in names, not the words of the mechanism (manager, handler, helper).
- Do not mix high-level steps and low-level detail in one function.

**The test.** After a restructure, some question is quicker to answer. If none is, undo it.

**You skipped it when** a ten-line change takes five open files to review, or a comment restates what a better name would have said.
