# Compare before committing

**Rule.** When the codebase offers no precedent for a decision, lay out two or three real alternatives and compare them before choosing.

**In practice**

- Alternatives must disagree about something structural: where data is held, which side owns an interface, what the person using it experiences. Renamings of one approach do not count.
- Spend little on each: an outline of the interfaces, a diagram, a disposable prototype. You are buying a view of the consequences.
- Fix the criteria before comparing, and compare one criterion at a time.
- If a quick experiment would decide it, run the experiment.
- Write down what was not chosen and the reason.

**Reading the outcome.** Alternatives that independently arrive at the same structure are a good sign; go ahead. Alternatives that share nothing suggest a constraint is missing from the brief; find it first.

**Skip it when** the codebase already has an accepted way to do this. Use that.
