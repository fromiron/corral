---
name: failing-test-first
description: "Writes a test that fails for the right reason before writing the code that makes it pass. Use when fixing a bug or adding behaviour that a fast, self-contained test can express. When no such test is possible, skip it and say what was checked instead."
license: MIT
---

# Failing test first

A test you have never seen fail has not shown that it can.

## When to use it

Use it when the behaviour can be exercised through a public interface in a quick local test. Skip it when the only possible test needs outside systems, takes minutes, or would assert something you cannot state exactly. When you skip, say why, and say what check you used instead.

## Steps

1. **Write one test.** Give one specific input to the entry point a caller would use. The expected result comes from the request or the bug report. Do not copy it from what the code currently returns.
2. **Run it and watch it fail.** Read the failure message. It must fail because the behaviour is missing or wrong. A failure from a typo, a missing import or broken set-up is the wrong failure; repair the test and run it again.
3. **Make it pass** with the smallest change. See the smallest-change skill.
4. **Run the neighbours.** The existing tests for the same area must still pass.
5. **Try two experiments in your head.** Sabotage the behaviour: the test must go red. Rewrite the inside and keep the behaviour: the test must stay green. If either answer is wrong, rewrite the test.
6. **Record the test before the fix.** Where you control the history, the test goes in first, so a reader can see it fail and then pass.

## Do not

- Assert on a value the test itself constructed.
- Work out the expected result with the code being tested.
- Replace the thing under test with a fake.
- Assert on calls between internal functions.
- Loosen or delete a failing test in order to finish.

## Hand back

- The test, and where it lives.
- Its output when it failed and its output when it passed.
- The neighbouring tests you ran.
- Any test you chose not to write, and why.
