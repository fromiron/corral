---
name: corral-review
description: "Reviews an immutable output against the current criteria and returns pass, revise or inconclusive without claiming verification that did not happen. Use when a Corral role is asked to review a change, a design or a document, or to submit a review result."
license: MIT
compatibility: "Designed for Corral."
---

Read the exact target artifact and current criteria. Respect review-only scope; do not modify files merely because you found an issue.
State the observed failure, affected behavior, evidence and required or advisory severity. Check realistic failure, cancellation, duplication and stale-result risks when relevant.
Use pass only when the required scope is supported. Use revise for a concrete unmet criterion and inconclusive when evidence is missing. Do not count valid JSON as a passing review.
For Corral review output, submit only the host's existing review JSON contract. A detailed design or investigation report may be a separate artifact, but cannot replace the final contract. Commands, their output and what remains unverified go in that separate artifact.
Use actual supplied criterion and evidence IDs. A targeted review is not release verification. Keep rejected approaches and unverified claims out of the pass decision.
