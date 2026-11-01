# Local judge experiment protocol

Two independent tasks: general multiparty conversational recipient selection, and minimum useful reasoning effort for the next coding response/step. A shared backbone is a candidate, not a requirement. Existing shipped weights stay the reference until a candidate passes its independent release gate.

## Teachers and evidence

- Primary: `gpt-6.1-sol`, explicit `high`; independent verifier: configured Hive DeepSeek, explicit `high` (or higher supported level). Never use automatic effort for a teacher. Persist requested model/effort, request hash, response hash, completion and usage, without credentials or hidden reasoning in public artifacts.
- GPT uses the existing ChatGPT-authenticated Codex CLI or Corral's OAuth-only subscription transport, with the actual serialized effort verified. Keep transport outcomes separate. Hive uses Corral's origin-bound credentials and provider transport. Standalone DeepSeek Harness is available for independent failure analysis; record the harness separately instead of pooling its outcomes with Corral's.
- No additional paid API or GPU rental. Use the local Ryzen 5600X / RTX 3070 8GB. No live teacher call in ordinary CI.
- Teachers return labels and short observable evidence references, not hidden chain of thought. Disagreements are retained; unresolved cases are not forced into certain labels. Model labels are never described as human ground truth.

## Data and splits

Pilot 300 cases/task; learning curves at 1,000, 3,000 and up to 10,000 training cases/task. Korean/English/Japanese target mixture 60/25/15. Coding is at most 20% of meeting scenes. General conversation includes ideation, planning, personal experience, causality, comparison, disagreement and follow-ups with 2–6 participants.

Each original conversation/task and all derived variants share one group. Exact/near duplicates are grouped before splitting into F (fit), C (probability calibration), P (policy selection), H (sealed final). Growing corpora quarantine collisions across already assigned splits; they never move previously exposed fit data into holdout. Freeze split manifests before fitting. Training recipe selection uses grouped CV within F. C is excluded from all member/scaler fitting. H has an exposure ledger and is not used for iteration. Existing published tests and prior real-record final are preserved as regressions, not relabeled as fresh H.

Use separate reports for natural records, controlled synthetic cases and executable outcomes. Private text stays outside Git. Synthetic variants change names, candidate order, recency, evidence ownership, exclusions, topic and linguistic forms; retain semantically appropriate label changes. New phrasing families, conversations and projects are held out together.

## Controlled comparisons

1. Fixed EmbeddingGemma 2 with old versus structured input, linear/MLP/5-head classifiers.
2. EmbeddingGemma 2 adapter and encoder tuning with role-specific objectives.
3. mGTE multilingual reranker 306M and Qwen3 Reranker 0.6B joint-input classification.
4. Qwen3.5 0.8B and LFM2.5 1.2B short structured decisions. 2B is an upper-bound challenger only after smaller learning curves flatten.

Compare 256/512/1024/2048 token budgets; 4096 is a long-context diagnostic. Prefixes and special tokens count. Check export/inference feasibility before full training. Pilot seed 41, confirmation seeds 41/42/43. Encoder LR grid 1e-5/3e-5, LoRA rank 8/16, at most 3 epochs with F-internal validation. EmbeddingGemma uses BF16/FP32, not FP16. Measure input × structure interactions before eliminating a family, then data curves and leave-one-component-out ablations.

Compare independent task tuning, a shared tuned encoder with separate heads, and shared base with task adapters. Do not force sharing if it harms either task. Compare effort CE/ordinal/per-level success objectives and meeting pointwise/listwise/speaker-relation objectives. No test-selected probability thresholds.

## Final behavior and gates

Meeting: explicit recipients/mentions win; secretary remains explicit-only. Distinguish eligible, excluded, one/set/all/none. Ambiguity chooses one suitable participant, not everybody. Explicit none or no permitted participants yields no run. Inference-failure fallback chooses an allowed reply target, then recent conversational participant, then stable round-robin. Record fallback separately. Compare with current selector, all, last speaker and cosine. Promotion requires +5pp valid-dispatch success over the strongest reference with group 95% CI excluding zero, no regression on natural exclusions, and all explicit-constraint tests passing.

Effort: preserve task success while reducing cost. Compare fixed low/medium/high, current policy and candidate on 200 independent executable task/step snapshots, twice at supported levels. Pilot outcomes used for recipe decisions are excluded from the fresh final cohort. Freeze success checks before outputs. Main gate: paired one-sided 95% success delta lower bound >= -2pp versus fixed high, >=10% total-token reduction with CI excluding zero. Report medium/current comparisons, raw labels, applied decisions, severe under/over calls, latency and reported usage. Outcome runs may use low/medium; all teachers/verifiers remain high+.

Existing total deadlines remain effort 3s / meeting 1.5s. Measure CPU/GPU cold/warm/contention and 2/4/6-participant meetings. Initial product cap: 1.5GB downloaded artifacts and 3GB additional resident memory. Prefer the smaller/faster candidate when quality differs by <=1pp without statistical separation. Quantized/native inference must repeat the gate. Insufficient evidence means experimental status, not a default-weight replacement.

## Delivery

Version input, tokenizer, backbone, precision, heads, calibration and policy together. Preserve command replay, revision checks, cancellation and Coordinator execution. Each role has independent activation/rollback. Deliver split/provenance manifests, reproducible training/evaluation, paired predictions, failure analysis and resource measurements. Run lint/typecheck/contracts/dependency checks and relevant unit/integration/UI plus live native checks for selected runtime changes.
