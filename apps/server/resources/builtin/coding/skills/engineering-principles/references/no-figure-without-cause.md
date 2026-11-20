# No figure without its cause

**Rule.** A measurement is usable once you can say what it measured and what holds it where it is.

**In practice**

- Record the conditions with the figure: input, machine, build, number of runs.
- Identify the constraint. Change the thing you believe is being measured. If the figure does not respond, something else is being measured.
- Eliminate the usual false readings: the operation failed fast and looked quick, a cache did the work, start-up cost swamped the part of interest, the test client was slower than the server, an old build was still running.
- Run it more than once and look at the variation. When two figures differ by less than the variation, the difference is noise.
- Ask whether the figure matters to the person waiting. Halving a step that is one percent of the wait changes nothing they can feel.

**Do not** assert a limit you have not tested for. Do not quote a figure you did not take; describe how you would take it.
