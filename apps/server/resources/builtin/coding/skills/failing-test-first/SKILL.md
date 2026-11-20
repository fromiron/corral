---
name: failing-test-first
description: "Writes a test that fails for the right reason before writing the code that makes it pass. Use when fixing a bug or adding behavior that a fast, self-contained test can express. When no such test is possible, skip it and say what was checked instead."
license: MIT
---

# Failing test first

A test you have never seen fail has not shown that it can.

## When to use it

Use it when the behavior can be exercised through a public interface in a quick local test. Skip it when the only possible test needs outside systems, takes minutes, or would assert something you cannot state exactly. When you skip, say why, and say what check you used instead. If you cannot run tests, write the test only if it is cheap, and report it as not run.

## Steps

1. **Write one test.** Give one specific input to the entry point a caller would use. The expected result comes from the request or the bug report. Do not copy it from what the code currently returns.
2. **Run it and watch it fail.** Read the failure message. It must fail because the behavior is missing or wrong. A failure from a typo, a missing import or broken set-up is the wrong failure; repair the test and run it again.
3. **Make it pass** with the smallest change. See the smallest-change skill.
4. **Run the neighbors.** The existing tests for the same area must still pass.
5. **Question the test.** Would it fail if the behavior broke? Would it still pass if the inside were rewritten and the behavior kept? If either answer is no, rewrite it.
6. **If you are asked to commit, the test goes in first,** so a reader of the history can see it fail and then pass.

## Do not

- Take the expected result from the code being tested, or from data the test set up itself.
- Assert on anything a caller could not observe.
- Test a stand-in in place of the real thing.
- Loosen or delete a failing test in order to finish.

## Hand back

- The test, and where it lives.
- Its output when it failed and its output when it passed.
- The neighboring tests you ran.
- Any test you chose not to write, and why.
