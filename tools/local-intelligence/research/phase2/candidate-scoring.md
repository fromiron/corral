# Frozen-embedding participant ranking comparator

This offline comparator ranks one participant for observed-response selection.
It does not implement silence, all/set dispatch, explicit exclusions, mentions,
or the production meeting policy. Only `mode=one` rows without exclusions enter
its training and ranking metrics. Other modes remain counted as out of scope.
Human-linked response alternatives mean observed responders, not proof that
unlinked participants ought to stay silent.

Features use only the supplied current message, roster name/role, and the actual
last twelve completed history turns. Reuse `meetingCosineInputs` for combined
name/role and owned history. The per-participant feature vector contains combined
name/role, name-only and role-only query cosines; maximum, mean and latest owned
history cosines; whether any owned history exists; turn and character activity
fractions; reciprocal latest-own-turn distance; and indicators for the latest
turn and latest roster speaker. No ID identity, target, corpus annotations,
future response, or relation type enters these values. Missing history has zero
similarities and an explicit zero presence indicator. Ties keep roster order.

Use the installed shipped EG2 model and CPU LiteRT engine, classification prefix,
256-token limit and truncation unchanged. Cache normalized native vectors and
derived features outside Git with source, input, model, helper and engine hashes.
Token counts are unavailable in this native API and must not be fabricated.
Per-text resident embedding time is not production end-to-end meeting latency.

All source splits must be frozen before extraction. The extractor admits only F
for now, with each exact source-file hash explicitly pinned. Natural rows must
match the frozen team membership. Existing synthetic F is independently pinned.
No C/P/H reads occur in this preparation or fitting path.

Compare two fixed shared heads: linear and ReLU with sixteen hidden units.
Minimize listwise negative log probability of the eligible set, with L2 0.01,
at most 200 L-BFGS iterations and seeds 41/42/43 for three grouped F folds.
All variants of a team/scene stay together. Within each domain, groups receive
equal weight and rows share their group's weight; natural and synthetic domains
receive equal total weight. Fit feature means/scales only on training groups.
No checkpoint or hyperparameter selection uses the held-out F fold. Report
optimizer convergence honestly. Export research weights without activating them.

Report natural and synthetic ranking accuracy separately, both row weighted and
equal group weighted. Compare the existing fixed role/history cosine grid and
latest visible roster speaker on the identical eligible rows and grouped folds.
F scores are development evidence. Candidate/reference selection on P, any full-F
refit for that comparison, and eventual H exposure require later explicit steps;
none is performed automatically by this runner.
