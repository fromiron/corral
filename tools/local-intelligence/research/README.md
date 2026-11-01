# Local judge research

The two tasks have separate inputs, labels, calibration, policies, and release
decisions: choosing a useful coding effort level, and choosing appropriate
participants in a general group conversation. A shared model is one candidate.
The [protocol](protocol.md) owns the split rules, teacher requirements, resource
limits, and promotion gates. These tools do not replace the default weights.

## Evidence boundaries

- Teacher agreement is not executable task success or human ground truth.
- `F` selects training recipes; `C` calibrates probabilities; `P` selects policy;
  `H` stays sealed until the candidate, runtime, and policy are fixed. Replay of
  final rows requires an explicit flag and writes an exposure record.
- Original scenes, translations, permutations, and related stages retain their
  groups. An expanded corpus quarantines cross-split duplicate components.
- Executable coding snapshots use hidden, deterministic checks inside Bubblewrap.
  They measure a supplied-source next response, separately from the real Corral
  Coordinator/tool-path probes in `harness-validation/`.
- Independent fixture review never reads worker answers. Rejected fixtures and
  tests remain intact. Approved source-preserving revisions require **new** worker
  runs; existing answers are not retrospectively regraded.
- `meeting-oracle.ts` derives recipients from controlled conversation facts and
  explicit rules. Its variants share template-family groups. It is not a natural
  conversation benchmark. `ami.py` separately measures recovery of public AMI
  single-addressee annotations; gaze/nonverbal context and pretraining overlap
  remain limitations.

All raw records, responses, weights, caches, and prediction files stay in a
private directory outside Git. Public reports contain aggregates and provenance
hashes. Live teacher/worker commands are opt-in and are not ordinary CI tests.

## Comparisons

The experiment includes frozen linear/MLP heads, structured versus legacy input,
encoder-layer/LoRA tuning, CE/ordinal effort objectives, candidate/history/joint
meeting views, and short-answer SFT retaining the pretrained LM head. Candidate
families include EmbeddingGemma 2, multilingual GTE reranker, Qwen3 reranker,
Qwen3.5 0.8B, and LFM2.5 1.2B. The `full` encoder recipe updates contextual
layers while retaining the vocabulary table; it does not update every parameter. LFM's custom license is recorded as an experimental
constraint; it is not silently approved for distribution.

The following is **development evidence**, before final gates, on the same
expanded F holdout for each column:

| Candidate | Effort correct / 90 | Meeting valid / 130 |
|---|---:|---:|
| Shipped classifiers and legacy fallback | 31 | 28 |
| Shared Qwen3.5 SFT | 79 | 121 |
| Separate Qwen3.5 meeting SFT | — | 122 |
| Separate Qwen3.5 meeting SFT, permutation views | — | 120 |
| Shared LFM2.5 SFT | 67 | 113 |
| Separate LFM2.5 meeting SFT | — | 117 |

Three larger-data shared-Qwen F folds produced effort agreement of
133/150, 189/210, 236/270 and meeting validity of 233/240, 198/210, 222/230.
Each used fixed epoch three and reported the tasks independently. These folds
are model-selection evidence, not fresh final results. On the same three effort
folds, contextual EG2 tuning reached 540/630 with CE and 542/630 with ordinal
loss, versus shared Qwen's 558/630. A new MLP on the unchanged installed native
EG2 embeddings reached 76.0%. These results support the current shared-Qwen
candidate; they do not establish a ceiling on EG2's possible accuracy.

The native policy set selected Q8 over Q4: effort label agreement was 39/40
versus 37/40, and meeting valid dispatch was 248/250 versus 244/250. Q4 missed
the predeclared one-percentage-point tolerance on both roles. Effort P has only
four independent groups; this is selection evidence, not a precise estimate of
future accuracy. C-only temperatures are 1.0725250686877876 (Q8) and
1.635665100705862 (Q4).

The strongest meeting reference on P was the unchanged embedding's role/history
cosine mixture with role weight 0.25: 131/250 valid dispatches. Its identity is
fixed before H, and its extra embedding work is reported separately. Native
model errors and late answers are evaluated through the actual fallback rule.

The first frozen meeting evaluation **did not pass promotion**. The following
rates give each original group equal weight, with the same inputs for every
model in a row:

| Final population | Groups / rows | Shipped selector | Q8 candidate | Frozen stronger reference |
|---|---:|---:|---:|---:|
| Synthetic teacher agreement | 15 / 150 | 32.67% | 95.33% | 47.33% |
| Controlled recipient rules | 12 / 216 | 5.56% | 62.04% | 42.59% |
| AMI human addressee agreement | 8 / 389 | 26.11% | 47.33% | 57.10% |

The controlled improvement's group 95% interval includes zero; forbidden
dispatches increased from 7 to 13 against the stronger reference. AMI's paired
delta was −9.77pp, interval [−19.78, −0.87]. None of these 755 predictions had
input clipping, a native error, or a deadline miss. Independent high-effort
verifier labels cover all 150 synthetic H cases; candidate agreement is 93.33%.
These are different estimands and are not pooled. Full sanitized aggregates,
diagnostics, and provenance are in [meeting-v3.json](results/meeting-v3.json).

This candidate remains experimental. In particular, the AMI view used dialogue
act fragments as prior entries; it is a bounded proxy for Corral's complete
messages. A later experiment must freeze fresh groups and disclose any input
or label-definition change. The exposed H populations remain preserved as
regression evidence rather than being relabeled as fresh evaluation.

The separate coding gate also **did not pass**. Its frozen 200 independent
families supply two worker repetitions at each of four effort levels (1,600
receipts), all through GPT-6.1-sol's Corral subscription path. The candidate
mapping `[0,0,0,2]` was selected and refitted on development only, with fixed-high
native-failure fallback and no external judge.

| Frozen policy | Successes / 400 | Mean reported total tokens | Saving versus high |
|---|---:|---:|---:|
| Q8 adaptive mapping | 396 | 1,334.04 | 6.30% |
| Supplied ONNX asymmetric/relative-low | 396 | 1,266.57 | 11.04% |
| Fixed low | 396 | 1,260.10 | 11.49% |
| Fixed medium | 398 | 1,293.82 | 9.12% |
| Fixed high | 398 | 1,423.70 | — |
| Shipped Corral policy | 398 | 1,722.29 | −20.97% |
| Q8 identity mapping | 398 | 1,764.97 | −23.97% |

The adaptive policy's success delta is −0.50pp, with conservative one-sided 95%
lower bound −2.7542pp, below the −2pp allowance. Its token saving interval is
[5.0239%, 7.6399%], below the 10% target. No frozen policy passed both gates;
the development data had no signal for learning which tasks required escalation,
and constant low/medium were empirically preferable to the adaptive candidate.
This does not establish that low is sufficient for arbitrary coding work.

Fixture checks were frozen before their worker outputs. Independently approved
test repairs used fresh workers. Two families with incomplete transport records
received a declared, pre-unblinding recollection of their entire four-level,
two-repeat blocks; old and new receipts were never mixed. Every selected family
remained in the final denominator. See [effort-v3.json](results/effort-v3.json)
for the full aggregate, provenance, fixed comparators, and scope limitations.
The separate synthetic effort-label H partition remains sealed for a later
model comparison; none of these outcome results is difficulty-label accuracy.

Permutation diagnostics distinguish arbitrary model-ID order from the runtime's
canonical `p1..pN` roster. `augment.ts --canonical-roster` tests reordered people
with the same alias representation used in production. It does not count a
derived view as another independent scene.

## Running the tools

Use Node 24.15 and the pinned Python training requirements. The optional
`fast-requirements.txt` environment adds FLA acceleration separately from the
original reference environment. Its BF16 results are not bit-identical to the
reference kernels. Preserve the recipe/environment identity with every run.

Set `CORRAL_RESEARCH_ROOT` to a private directory. Commands accept explicit
paths so a checkout contains no credentials or private text. Typical stages:

1. `generate.py`, `verify.py`, and `prepare.ts`: high-effort generation, independent
   high-effort review, deduplication, and immutable grouped data snapshots.
2. `train.py` / `sft.py`: F-only fitting. `predict.py` / `predict_sft.py`: frozen
   replay. `split_eval.py` rejects overlap with actual fitted groups.
3. `merge_sft.py`, the pinned upstream GGUF converter, and `llama-quantize`:
   export adapters and create explicitly identified precision candidates.
4. `runtime-views.ts`: append the actual production input view, preserving source
   fields and targets. It compacts IDs, keeps the last 12 meeting turns, and
   records the map back to original recipients. C/P measurements can be reused
   only when the exact prompt and identity-map equivalence receipt supports it.
5. `native_predict.py`: replay the exact helper/model, verify HF/native token IDs,
   and record startup, warmup, latency, truncation, and deadline misses. Use
   runtime views for product-oriented meeting evaluation. Late raw predictions
   must not be counted as successful applied decisions.
6. `baseline.ts`: preserve the shipped selector plus its historical fallback,
   and also compare its corrected one-person fallback, all/first/last/cosine
   references and a predetermined role/history cosine grid. Core-derived effort
   snapshots use their exact `runtimeView.legacyText`.
   `reference-upstream.ts` and `reference_upstream_ort.py` replay the supplied ONNX
   model with its recovered, pinned compact tokenizer and turn/step formatter.
   The earlier turn-only `reference_onnx.py` reports remain historical views.
7. `fixtures.py`, `grader.py`, `review_fixtures.py`, `repair_fixtures.py`, and
   `qualified_trials.py`: create and independently qualify executable snapshots
   before fresh repeated worker runs. Keep infrastructure errors and missing
   usage separate from completed failures.
8. `evaluation.py`: C-only temperature fitting, paired grouped intervals, and
   conservative success/cost gates. See [statistical methods](methods.md).

The three supplied ONNX/tokenizer/calibration files exactly match Mixdog's
`effort-judge-v7` manifest at commit
[`7e6abe16b9ed9c0947661d843d64b96e5b22d981`](https://github.com/tribgames/mixdog/tree/7e6abe16b9ed9c0947661d843d64b96e5b22d981/src/runtime/effort-judge);
the attached worker matches the pinned
source apart from trailing whitespace. The exact compact tokenizer is the
reference authority, with private cache files. It matched HF IDs on all 40 P
and 59 Core-derived development inputs. The replay uses Python ORT 1.31.1 CPU,
whereas the original Node dependency is 1.30.0; it is not claimed to reproduce
that unavailable runtime bit for bit. Its supplied temperature remains 1.55.

## Native execution

The [decision helper](../../../packages/local-intelligence/decision-helper/README.md)
uses pinned llama.cpp through an owned, socket-free process. It clears recurrent
and attention state between requests. A loaded model is not ready until its
fixed, non-sensitive warmup has completed. First-token effort scores are a
conditional four-label readout; calibration and action policy are separate.

Qwen3.5's HF tokenizer performs NFC normalization. The pinned native BPE path
does not apply it automatically, so the judgment copy is normalized before
native tokenization. Source messages/files remain unchanged. The observed
decomposed-filename mismatch was corrected, then all 2,670 F/C/P token sequences
matched exactly. This did not change training tokens or inspect final labels.

The [Linux build recipe](../../../packages/local-intelligence/decision-helper/build-linux.md)
produces a relocatable Ubuntu 24-class package, not a universal Linux binary.
The measured package requires GLIBC_2.38/GLIBCXX_3.4.32; other userlands and
desktop packaging need their own qualification. Current-host CPU and GPU
probes do not establish support for untested drivers or platforms.

Record Python and native source dependencies through `pnpm deps:record
--training` and `pnpm deps:record --native <private-build-report>`. The importer
keeps private build paths out of the public dependency record. Model promotion
and publication are separate from building an experimental artifact.
