---
name: measure-first
description: "Ties every performance claim to a measurement: take a baseline, find what limits the number, try the cheapest remedy first and compare like with like. Use when something is slow, when reporting a speedup or a regression, or before trusting any benchmark, latency or throughput figure."
license: MIT
---

# Measure first

Reading code tells you where time might go. Only a measurement tells you where it went.

## Steps

1. **Define the figure.** What is measured, in what unit, on what input, on what machine and build. Say what counts as one sample.
2. **Take a baseline before changing anything.** Several runs. Record the variation as well as the average. Note whether runs were cold or warm.
3. **Find what limits it.** Profile or trace. Use the code to form a theory and the measurement to confirm it.
4. **Question the figure.** Use the list below. A figure that fails one question is not ready to report.
5. **If you are improving it, try remedies in order of cost.** Use the second list below. Change one thing, measure again by the same method, and stop at the first remedy that reaches the target.
6. **Compare like with like.** Same input, build mode, machine and number of samples. Report the difference together with the variation.
7. **Check the whole journey.** A faster inner step that does not shorten what the person waits for has not helped them.

## Questions for every figure

- Did it time the work you meant, or set-up, a cache hit, or a failure that returned early?
- Did any run fail?
- Is the limit in the thing under test, or in what surrounds it: the client, the disk, the network, the logging?
- Does it move when the load or the input changes?
- Does a repeat give the same answer?
- Is the difference larger than the variation?

## Remedies, cheapest first

1. Remove the work. Nothing uses its result.
2. Reuse a result you already have.
3. Reduce the amount: a smaller input, fewer passes.
4. Postpone it until something needs it.
5. Move it off the path the person is waiting on.
6. Run independent parts side by side.
7. Switch to a cheaper method.

## Rules

- Do not report a figure you did not take. Describe how you would take it.
- Do not declare a limit you have not tested for.
- If you cannot run anything, say so, offer the suspected limit as a theory, and stop there.

## Hand back

The method, the baseline and the limit you found. If something was changed: the change, the figure afterwards and the difference with its variation. Then what was not measured.
