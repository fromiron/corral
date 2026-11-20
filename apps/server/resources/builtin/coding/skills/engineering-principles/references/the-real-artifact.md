# The real artifact

**Rule.** Confirm a result by looking at the result, not at something that usually accompanies it.

**In practice**

- Decide what "it works" means as something observable: this command prints that, this screen shows that, this row holds that value.
- Observe it on the current state of the work. Use the feature the way its user would. Print the value. Open the file that was produced.
- Know what accompanies success without being it: a clean build, a newer modification time, a green run from before your last edit, a status message written by the code being checked, a result served from a cache.
- A surprising failure may be the fault of the check. Confirm it looked at the right build, branch and data before concluding that the work is wrong.
- Edits expire evidence. Whatever you observed before changing a file has to be observed again.
- Prefer a check that someone else can repeat: a command, a small script, a recorded comparison.

**If you cannot run it,** read the path through and report the conclusion as traced. Traced is weaker than run and must carry its label.
