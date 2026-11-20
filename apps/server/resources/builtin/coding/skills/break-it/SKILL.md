---
name: break-it
description: "Attacks a piece of work to find where it fails, and reports only the failures that a run or a step-by-step trace actually shows. Use when asked for an adversarial review, a stress test of a diff, a search for blind spots, or a second look at work that seems finished."
license: MIT
---

# Break it

Your job is to make the change fail. A belief that it might fail is not a finding. A finding is a failure you can show.

## Steps

1. **Say what the change is for.** One or two sentences, taken from the request and the change itself. A failure counts only if it defeats that purpose. If the purpose is unclear, state what you assumed.
2. **Read the change and its surroundings.** Callers, data formats, configuration, tests.
3. **Choose your attacks.** If you were given a lens (correctness, security, concurrency), stay inside it. Otherwise pick from the list below the ones this change is exposed to.
4. **Carry each one out.** Write a failing test, a short script or a command that shows the wrong behaviour. If you cannot run anything, walk the path step by step, with file references, until it arrives at the wrong outcome.
5. **Keep what you showed. Discard the rest.**
6. **Combine findings that have one cause.**

## Lines of attack

- **Edges of input.** Empty, very large, repeated, malformed, the wrong type, unusual characters.
- **Order and timing.** Called twice. Called at the same moment. Cancelled halfway. A result that arrives late, or after a retry.
- **Failure paths.** A dependency errors or times out. A write half completes. Space or quota runs out.
- **State.** Stale data. A restart in the middle. Records written by the previous version.
- **Trust.** A missing permission. Another user's data. A path outside the allowed area. Untrusted text obeyed as an instruction.
- **Beyond the diff.** A caller that was not updated. A stored or transmitted format whose meaning changed. A default that changed.

## Rules

- Fix nothing. Leave the working copy as you found it. Put each reproduction in your report as text.
- Leave out matters of taste (style, naming, how the code is laid out) and hazards that only appear if someone changes the code later.
- Do not invent a caller, an input or an interface. If a search found nothing, say what you searched.
- An empty list of findings is an acceptable report.

## Hand back

- **Purpose.** What the change is for, as you understood it.
- **Findings.** For each: a title, whether it was run or traced, the exact command or the trace, the output, and what the purpose requires instead.
- **Withstood.** The attacks you carried out that did not break it.
- **Not attempted.** What you left out and why.

For damage outside the diff, see the change-impact skill.
