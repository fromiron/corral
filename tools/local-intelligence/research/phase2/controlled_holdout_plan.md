# Fresh controlled conversation holdout proposal

This is a prospective mechanism catalogue, not a generated or scored dataset. It does not reuse or rewrite phase1 holdout conversations. The phase1 controlled families and eight exposed AMI teams remain regression evidence only.

Natural AMI fitting data uses observed later responses to elicitations. It cannot establish normative silence, required multiple responses or explicit exclusion compliance. A separate rule-derived holdout is needed for those behaviors. Its labels must follow an inspectable conversation-state interpreter; inputs contain only ordinary conversation, participant aliases/roles and the current message.

## Reserved holdout mechanisms

Each row below is one group, including every language, name, order and state variant. Do not count its variants as independent groups.

| Family | Observable state and objective recipient rule |
|---|---|
| Accepted responsibility transfer | An explicit handoff changes the responsible participant only after acceptance; a declined or unacknowledged handoff does not. |
| Superseded request | A later cancellation or replacement invalidates the earlier request while leaving unrelated pending requests intact. |
| Remaining assigned work | Different participants own named subquestions; completed subquestions are closed and only the remaining assigned respondent is requested. |
| Conditional commitment | A participant has committed to respond when a stated prerequisite arrives; evaluate conjunction/disjunction using only already-posted facts. |
| Agreed speaking order | A recorded speaking order and completed contributions determine the next eligible turn, including skipped and resumed positions. |
| Expiring topic-specific recusal | A temporary opt-out applies only to its named topic and duration; an explicit return restores eligibility for that scope. |
| Topic-scoped responsibility | A participant is responsible for one agenda item but not another; crossing back between interleaved topics must preserve that scope. |
| Recorded alias change | An explicit, unambiguous alias update identifies the same participant across later references without assigning capabilities from the name. |
| Corrected contribution | A recorded correction retracts or replaces a prior contribution; use the acknowledged current claim, not first mention or repetition. |
| Stated evidence freshness | A previously agreed freshness condition determines which already-posted observation is eligible; older observations remain visible but do not satisfy it. |
| Explicit clarification owner | A visible discussion protocol assigns clarification to a designated participant when the stated matching rule has zero or multiple matches. |
| Conditional silence after closure | A repeated record-only question requests no new reply when its obligation is already closed, but an unresolved obligation still has its recorded respondent. |

## Construction boundary

- Freeze the catalogue of **new generated relational fitting families** before creating holdout instances. Those generators must exclude the reserved holdout family IDs and their state-machine templates. Record both catalogue hashes and check disjointness automatically.
- Use new situations, participants and language, not paraphrases of phase1 H. Reusing phase1 synthetic F is permitted as a separately identified fitting component; no phase1 H row or derivative enters fitting.
- Aim for 20 variants per reserved family, with 12 Korean, five English and three Japanese variants. This gives 240 rows but only 12 family groups. Include 2/4/6-person rosters where the mechanism supports them.
- Preserve one/set/all/none semantics. Ambiguous open invitations accept any one allowed respondent; they do not require every eligible participant to speak. Exclusion labels represent explicit constraints, not merely irrelevant participants.
- Avoid current @mentions or explicit UI recipient selection, which are already handled before the model. All state transitions needed by the oracle must appear before the current decision; future answers and hidden oracle state are never model input.
- Validate state changes, recipient remapping and family preservation before freezing the source, input and label hashes. Do not select thresholds or rewrite cases after seeing model outputs.
- Generated-family separation is not a claim that a concept is absent from natural fitting conversations or model pretraining. Report family-group confidence intervals and keep this controlled evidence separate from AMI observed-response recovery and general conversational relevance.

No instances have been generated from this proposal, and no teacher/model calls are authorized by the document itself.
