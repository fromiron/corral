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
repeat), at most twelve physical provider requests per execution, 12 logical
model calls, 24,576 output tokens, and 240 seconds per run. Failed executions
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
