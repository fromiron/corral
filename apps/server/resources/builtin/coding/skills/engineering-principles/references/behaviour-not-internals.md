# Behaviour, not internals

**Rule.** A test checks what callers of the code can see. How the code gets there is free to change.

**What callers can see.** Results, raised errors, stored state they can query, and messages or writes that leave the module. They cannot see private functions, the order of internal calls, or temporary values.

**Two experiments.** A useful test survives both.

1. Sabotage the behaviour: return the wrong answer, drop a side effect, or perform it twice. The test should go red.
2. Rewrite the inside without altering any visible outcome. The test should stay green.

A test that stays green in the first is decoration. A test that goes red in the second will be deleted by the next person who restructures the code.

**In practice**

- Call the public entry point with specific inputs.
- Work out the expected outcome by hand, from the specification or the bug report.
- Count a request sent to another system as visible. Do not count a call between two private functions.
- Be suspicious of assertions about objects the test set up itself.

**When a test fails,** either the code is wrong or what is wanted has changed. Find out which. Loosening the assertion until it passes is neither.
