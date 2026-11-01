# User-requested stopping checkpoint

Work stopped at the user's request. No new experiment should start until the
user asks to continue. All owned training, author, reviewer, and helper processes
have exited. In-flight provider requests completed before their orchestrator
was terminated; no unknown request outcome was introduced by stopping.

## Completed first experiment

Implementation and aggregate results are committed in `645aa7cf`. The
[research report](../README.md) links the complete meeting and coding aggregates.
Neither candidate passed its predeclared promotion gates. Existing default
weights and effort mapping remain; the GGUF factory integration is explicit
opt-in. Empty meeting selections and one-person failure fallback are implemented.

- Meeting: synthetic agreement improved, but controlled exclusions regressed
  and the natural AMI addressee result trailed the fixed stronger reference.
- Coding: 200 families, 1,600 receipts, no excluded selected families. Adaptive
  Qwen scored 396/400 versus high's 398/400, with 6.30% token savings; both the
  noninferiority and 10% savings gates failed.
- The separate synthetic effort-label H180 has not been scored. Exposed first
  meeting H and coding outcomes cannot become fresh gates again.

## Follow-up state

| Component | Preserved state |
|---|---|
| Natural observed-response corpus | Frozen: F959/11 teams, C246/3, P244/3, H733/10; 2,182 English cases from 27 unexposed teams. Whole prior speaker turns, last12, no future response text. This is linked-response recovery, not intended-addressee or normative relevance truth. |
| Unchanged EG2 candidate scorer | Two heads × three F folds complete. Natural accuracy: linear53.28%, ReLU16 54.64%, most-recent-speaker55.79%. Synthetic one/no-exclusion:89.81%/91.00%. ReLU fits hit the fixed200-iteration limit. No P/C/H fitting or scoring. |
| Two-view0.8B SFT | F source/view/group folds frozen. Accelerated timeline stopped during epoch1 after268s. **No completed epoch, adapter, optimizer checkpoint, or trained-candidate result.** Participant-index run and constrained effort replay never started. Untrained-base validation exists only as a diagnostic. |
| Earlier SFT attempt | Accidentally used reference kernels instead of the selected FLA environment. Preserved as interrupted and excluded from comparison; the corrected accelerated run is separate. |
| Controlled corpus | Planned F16/C8/P8/H12 families,20 variants/family. Only10F families/200rows qualified. One rejected, three author-completed but unreviewed, two F unstarted. C/P/H/replacements never called.14author and11review calls all have completed high-effort receipts; unknown0. |
| Independent H oracle |12reserved mechanisms ×2 contrasting symbolic states frozen and tested. Language realization/independent review is not complete. The F/C/P tooling author's accidental old-oracle source exposure is recorded; old scenes were not copied into fitting data, and a separate H author did not read oldH. |
|2B feasibility | LoRA1024 fits the current8GB GPU. Q4 model is1,274,396,800B. Standard no-mmap/context1536 or1152 probes reached2.983/2.979GB host+GPU sums, with only17–21MB margin and uncontrolled driver cache. Mixed-role/cold resource qualification is missing; CPU deadlines fail. No2B quality training or default activation. |
| DeliData | Read-only source audit completed. Text-native group deliberation, but no participant-target/reply-edge ground truth. Not added to datasets. |
| DeepSeek Harness | Installed CLI located. Existing default is medium; high override was investigated but **no DSH provider call or shared configuration change occurred**. |

## Private artifact keys

These paths are relative to the existing private research root, represented by
`CORRAL_RESEARCH_ROOT`; no data or credentials are committed here.

- `runs/meeting-final-v1/` and `runs/effort-final-v1/`: first-experiment evidence.
- `phase2/ami-observed-response-v1/manifest.json`: frozen natural corpus.
- `phase2/eg2-candidate-v1/`: feature/recipe freezes, exact shared F folds, F results.
- `phase2/sft-views-v1/`: immutable combined F and both input views.
- `phase2/sft-pilot-fast-v1/{freeze.json,stop-summary.json,handoff.json,code/}`:
  corrected source/environment snapshot and stopping evidence.
- `phase2/sft-pilot-v1/interrupted.json`: excluded reference-kernel attempt.
- `phase2/controlled-v1/checkpoint-stopped-v1/{manifest.json,fit-qualified.partial.jsonl,RESUME.md}`:
  incomplete qualified data and stage-aware continuation requirements.
- `phase2/controlled-v1/checkpoint-stopped-v1/public-source-portability.json`:
  post-stop replacement of a machine-specific Node path with
  `CORRAL_RESEARCH_NODE`/`PATH`; original frozen sources remain intact.
- `runs/phase2-feasibility/`:2B source, export, memory, latency and parity evidence.
- `phase2/source-audit/delidata-v1/`: bounded public-source audit.

## Resume boundaries

1. Verify the saved hashes and F-group identities. Use Node24.15 and the
   `.venv-fast` interpreter with FLA0.6 for the selected SFT recipe.
2. SFT requires a **fresh run from the pretrained base**, not continuation from
   a saved optimizer. The private `handoff.json` gives the frozen-source command
   and a fresh output directory. Do not overwrite either interrupted attempt.
3. Controlled generation needs a reviewed stage-aware continuation for the three
   completed authors. Reuse their verified responses; do not re-author them or
   remove request markers. Add/test cooperative stop before further long batches.
   The existing runner can process never-started families but cannot complete
   those pending review stages by itself. All future teachers/reviewers stay high+.
4. Keep natural H733 and controlled H sealed during F selection. Finish and
   qualify C/P/H controlled language data before treating it as an evaluation set.
5. Select models/views on F, calibrate/select policy on C/P, then freeze the exact
   native artifact and policy before fresh H. Do not promote an incomplete or
   failed candidate or interpret next-responder labels as universal relevance.

## Verification boundary

First-checkpoint runtime:2,759 tests passed/25 skipped; lint, typecheck,
contracts, dependency check, build and two Chromium smoke flows passed locally.
At stopping, research-only changes passed tools TypeScript,17 Node tests with
one private-resource skip,41 phase2 Python tests plus6 split-boundary tests.
The controlled16-test subset also passed after the Node-path portability edit.
No additional full application suite was needed for these research-only edits;
this does not assert hosted CI or cross-platform desktop qualification.
