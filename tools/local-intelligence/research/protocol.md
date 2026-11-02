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

Effort: constant medium is the reference, because it is the shipped automatic behavior (`corral-effort-v3`). `coding_gate.py` holds both steps below, and neither changes after its first run.

Screening asks whether the level changes real outcomes, with no judge and no training. The tasks are frozen in `harness-validation/hard-tasks.json` from content only: 12 SWE-bench Verified tasks and 12 Corral fix commits. Each runs once at medium and once at xhigh with no limit on calls, output or time, because high levels often pass any fixed count. Guards only end a runaway run, and a run stopped that way, or by any spending limit, is unsettled rather than failed. Stage A is the 3 lowest ranks of each kind on GPT-6.1 Sol, stage B all 24 on Sol, stage C the 6 lowest ranks of each kind on GPT-6 Luna, run only when B stays under the line. An xhigh-only task passes at xhigh and fails at medium. At 5% of tasks or more on either model, add tasks and repeats and build a judge. Under 5% on both, close adaptive judging: constant medium with manual raises is the final behavior, and `judged` and the judge weights are removed. Medium-only tasks are reported beside it because they show what one run's noise looks like. A run that fails stays in the denominator, and limits are failures. A run that did not settle (transport, quota, host) blocks the decision instead of counting as no difference. One run per task sees little: 1 of 24 stays under the line, and a true rate of 10% shows one or none 29% of the time, 15% shows it 11%, 20% shows it 3%.

Stage D runs the 3 lowest ranks of each kind on DeepSeek V4.1 Flash at low, high and max, the levels its API offers. It has no medium or xhigh, so it never counts toward the rule above, which GPT-6.1 Sol and GPT-6 Luna decide. It shows whether the level changes outcomes on a third model, and it tests the harness on hard tasks before a stage spends the subscription.

Promotion of a judge needs 110 independent executable families outside the screening set, two paired repeats per policy. The primary metric is wall seconds per success, with failed runs in the numerator: a policy that only raises effort is credited with the failures it avoids, and giving up early buys nothing. Its reduction against constant medium needs a paired whole-family 95% interval above zero. Success needs a paired one-sided 95% lower bound of at least -5pp. Reported total tokens are always reported and do not gate. Freeze success checks before outputs; pilot outcomes used for recipe decisions are excluded from the final cohort. Report raw labels, applied decisions, severe under/over calls, latency and reported usage. Outcome runs may use any level; all teachers/verifiers remain high+.

Success lower bound in percentage points by families with a net loss and no offsetting gains (`python coding_gate.py`). At 110 families one net loss passes -5pp and two do not; gains relax the bound. This is why the earlier -2pp gate at 200 families failed on a single loss.

| Families | 0 lost | 1 lost | 2 lost | 3 lost |
|---:|---:|---:|---:|---:|
| 24 | -14.2 | -21.1 | -27.0 | -32.4 |
| 72 | -5.0 | -7.5 | -9.7 | -11.7 |
| 110 | -3.3 | -5.0 | -6.4 | -7.8 |
| 200 | -1.8 | -2.8 | -3.6 | -4.3 |
| 400 | -0.9 | -1.4 | -1.8 | -2.2 |

Existing total deadlines remain effort 3s / meeting 1.5s. Measure CPU/GPU cold/warm/contention and 2/4/6-participant meetings. Initial product cap: 1.5GB downloaded artifacts and 3GB additional resident memory. Prefer the smaller/faster candidate when quality differs by <=1pp without statistical separation. Quantized/native inference must repeat the gate. Insufficient evidence means experimental status, not a default-weight replacement.

## Delivery

Version input, tokenizer, backbone, precision, heads, calibration and policy together. Preserve command replay, revision checks, cancellation and Coordinator execution. Each role has independent activation/rollback. Deliver split/provenance manifests, reproducible training/evaluation, paired predictions, failure analysis and resource measurements. Run lint/typecheck/contracts/dependency checks and relevant unit/integration/UI plus live native checks for selected runtime changes.
