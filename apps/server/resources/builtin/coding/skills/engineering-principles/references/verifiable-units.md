# Verifiable units

**Rule.** Do work in pieces small enough that each one can be confirmed before the next begins.

**In practice**

- Size a piece by its check. A good piece has a quick, definite one: this test passes, this caller now uses the new function, this folder builds.
- Confirm at the end of every piece. On the first red result, stop. The fault is in the last piece and nowhere else.
- In repetitive work, complete a single instance, confirm it, and then repeat the pattern.
- Anything the rest depends on goes first and is confirmed before the work fans out.
- Arrange what you deliver so a reader can follow the proof: the test that exposes the problem and then the correction; deletions, then the new structure, then tidying.

**You skipped it when** a large change breaks and the cause could be anywhere, forty files were edited and checked once at the end, or the test and the fix appeared together so nobody saw the test fail.
