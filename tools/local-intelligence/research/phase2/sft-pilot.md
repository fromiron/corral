# F-only two-view SFT pilot

The pilot combines the unchanged synthetic F rows with frozen natural F rows.
It compares canonical meeting timelines with the visible participant history
index; effort text stays byte-identical. Neither representation reads targets.
Natural observed responders and synthetic normative dispatch are reported
separately, alongside effort and paired same-ID differences.

Use the original pretrained Qwen3.5 0.8B, joint short-answer SFT, three fixed
epochs, rank16, learning rate0.00003, 1024 tokens and seed41. The v3 fitted
adapter is not an initialization. The initial comparison runs fold0 only.
Freeze source hashes, input hashes, recipes and group membership before fitting.
Relational additions require a separately versioned dataset and ablation.

An optional `--holdout-manifest` selects explicitly frozen F group folds.
Its `fitSha256` must match the exact input file bytes; its disjoint, nonempty
folds must partition all F groups exactly once. Unknown, missing, duplicated
or non-F groups are rejected. The default remains the existing five-fold hash
rule. Explicit manifests cannot be combined with full-F refitting.

Runs record the exact F hash, manifest hash and actual train/dev groups.
Fit-dev replay of an explicit split checks the same F hash and uses the stored
actual groups, rejecting train/dev overlap. The meeting folds match the frozen
candidate-scorer folds; additional effort groups use a separately frozen
deterministic three-fold assignment. No C/P/H inference or selection occurs.
