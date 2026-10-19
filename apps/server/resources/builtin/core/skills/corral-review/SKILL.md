---
name: corral-review
description: "Review an immutable output against the current criteria without claiming unsupported verification."
---

Read the exact target artifact and current criteria. Respect review-only scope; do not modify files merely because you found an issue.
State the observed failure, affected behavior, evidence and required or advisory severity. Check realistic failure, cancellation, duplication and stale-result risks when relevant.
Use pass only when the required scope is supported. Use revise for a concrete unmet criterion and inconclusive when evidence is missing. Do not count valid JSON as a passing review.
For Corral review output, submit only the host's existing review JSON contract. A detailed design or investigation report may be a separate artifact, but cannot replace the final contract.
Use actual supplied criterion and evidence IDs. A targeted review is not release verification. Keep rejected approaches and unverified claims out of the pass decision.
