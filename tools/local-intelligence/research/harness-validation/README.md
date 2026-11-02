# Bounded coding harness validation

This development-only smoke uses Corral's existing `startCorralServer`,
`prepareEvaluation`, `InProcessTransport`, and `executeOnce` path. Each trial
creates a fresh fixture Git repository and a separate managed working copy.
The model runs in Corral's strict SDK process worker; file operations and the
registered check use the normal Coordinator/broker paths. A small tracked
`harness_check.py` fixture helper runs the registered test command in bubblewrap
with no network or home mount; its content hash is verified after execution.
The SDK process itself is not OS
sandboxed: Corral currently refuses the combination of `workerIsolation` and
registered checks. That refused zero-provider-call attempt is retained under
`admission-refused/`. The incompatible compressed subscription transport
attempts are retained separately under `transport-rejected/`; they reached
the payload hook but the request fence prevented HTTP dispatch. No original checkout
is linked. The fixed provider is `openai-codex`, model `gpt-6.1-sol`, and OAuth
is required before starting. Every serialized request is checked for the exact
requested effort. There is no API-key fallback.

The manifest contains five authored development cases, one each from batches
0000–0004, covering parsing, asynchronous publication, dependency invalidation,
cancellation, and pagination. Selection uses fixture content only. Batches
0020 and later are sealed: the loader rejects them before reading their files.
Only `case.json` is read, never outcomes from other worker experiments.

The reference must pass and the initial source must fail the existing
`research/grader.py` sandbox before a live trial starts. Reference files stay in
the host's private preflight directory and are never copied to either worker
repository. Tests are visible, as in a normal coding repository. Final grading
restores the original tests and runs with no network or home mount. A modified
test file invalidates success even when the original tests pass.

The live budget is ten worker executions (five cases × medium/high × one
repeat), at most twelve physical provider requests per execution. The definition
also names 12 logical model calls, 24,576 output tokens, and 240 seconds per run,
but without `executionPolicy.budget` Corral runs unlimited and does not apply
them, so the driver's physical request cap is what bounded this smoke. Failed executions
remain in the denominator. A started execution is never silently retried.
There are no teacher or reviewer calls in this slice. Medium/high refer only
to the evaluated worker, with the effort fixed across that entire run.

```sh
python tools/local-intelligence/research/harness-validation/run.py \
  --root "$CORRAL_RESEARCH_ROOT" --preflight-only
python tools/local-intelligence/research/harness-validation/run.py \
  --root "$CORRAL_RESEARCH_ROOT" --live
python tools/local-intelligence/research/harness-validation/report.py \
  --root "$CORRAL_RESEARCH_ROOT"
```

Use the repository-required Node 24.15.x on `PATH`; `CORRAL_RESEARCH_NODE` can
also select that executable explicitly. The script
stores private fixtures, events, source/check hashes, wire observations,
normalized usage/cache counts, actual HTTP dispatch and serialized payload
counts separately, timings, test outcomes, and a summary under
`outcomes/harness/`; isolated servers/repositories live under
`runs/harness-agent/`. It never commits or pushes the product checkout. The
private fixture Git commits are solely immutable evaluation starting points.

The driver exports `runHarnessTrial` with a required effort argument, providing
a replay hook for a later frozen candidate's externally selected effort. The
current orchestrator only permits medium/high and does not select a policy.
An adaptive per-step policy is not evaluated by this fixed-effort smoke.

The first recorded ten-run slice used Python without `-B`. Bytecode creation
made those registered check copies dirty, so Corral correctly kept their
verdicts inconclusive despite exit code zero. The independent immutable grader
provided the final test verdict. The current helper uses `-B`; its clean-tree
check was verified offline using the completed worker patches. No extra model
runs were added. Per-run driver hashes preserve the measured version, and its
latency includes repeated checks caused by that fixture issue.

This evidence is separate from hidden-test, no-tools next-response trials.
Five visible-test coding tasks can demonstrate real Corral tool and completion
paths, but cannot establish an optimal effort policy or general task-success
rate. Meeting participant selection is outside this validation.

## Hard tasks

`protocol.md` owns the screening rule and `coding_gate.py` its arithmetic. This
section is how the runs happen. `hard_tasks.py` orders 15 SWE-bench Verified
tasks and the 14 Corral fix commits that qualify, from task content only, into
`hard-tasks.json`. The 45 hard SWE-bench tasks span 8 repositories, so a
repository supplies at most two. A qualifying commit starts with `fix`, keeps a
message body that states the task, changes at least 3 files including a source
file and a Vitest file, and changes no dependency file. Commits with a single
source file come after all the others and are used only as replacements.

`hard_run.py --preflight-only` gives each task an environment and takes the
first 12 of each kind whose reference passes and whose starting code fails, in
that order, into `hard-set.json` with the hashes of every file a run depends on.
`--live` refuses a stage when any of those files changed. SWE-bench verdicts
come from the official grader in `swebench-requirements.txt`, and SWE-bench stays
evaluation-only. A Corral task passes when every test in the commit's own test
files passes on the commit's versions of them. Those tests can be stricter than
the fix they cover, for example by naming a new label, which counts against both
levels alike.

The worker sees a one-commit repository with no history and no hidden test. It
keeps the strict policy of the smoke. `run_command` needs trusted-native, which
would run model-written commands on this host next to the credentials, so
commands go through one registered check instead: the worker writes a script
under `.harness/commands/` and `sandbox.py` runs the newest one in a throwaway
copy with no network and no home, in Docker for SWE-bench and bubblewrap for
Corral. Each command costs an extra model call, so token and time totals compare
levels with each other and do not predict a normal Corral session. The model
process itself runs on the host as in the smoke.

A stage run has no limit on calls, output or time, because high levels often pass
any fixed count and a stop there would read as a failed task. Guards at 1,000
requests and six hours only end a runaway run. A run stopped by a guard or by a
spending limit is unsettled, not failed, and stops the stage for review.

```sh
python hard_run.py --root "$CORRAL_RESEARCH_ROOT" --preflight-only
python hard_run.py --root "$CORRAL_RESEARCH_ROOT" --dry-run
python hard_run.py --root "$CORRAL_RESEARCH_ROOT" --smoke <task-id>
python hard_run.py --root "$CORRAL_RESEARCH_ROOT" --live --stage A --model gpt-6.1-sol
python hard_run.py --root "$CORRAL_RESEARCH_ROOT" --report --stage A --model gpt-6.1-sol
```

`--dry-run` starts Corral on one task of each kind and stops before any provider
call. `--smoke` spends one DeepSeek run to prove the path end to end, at the level
`--effort` names, and its results never enter a stage.

Stage D (`--live --stage D --model deepseek-v4.1-flash`) runs stage A's tasks on
DeepSeek at low, high and max. The API has no medium or xhigh, so its report says
`gateEvidence: false` and the screening decision ignores it.

A live stage spends money or the subscription, so each one needs explicit approval
first. A started run is never replayed, and a run that did not settle stops the
stage for review.
