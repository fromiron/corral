# GGUF JSONL research helper

This opt-in experiment does not replace the product's LiteRT engine, weights, or
installation manifest. It uses an existing pinned llama.cpp build and the same
stdin/stdout process boundary as `HelperProcess`.

Research contract:

- CPU by default; one context and one request at a time. No sockets or model download.
- The caller supplies the exact preformatted, thinking-disabled SFT prompt.
- An optional integer `inputBudget` explicitly enables token-ID clipping to the
  first 128 IDs plus the last `inputBudget - 128` IDs, only when the original
  input exceeds that budget. Budgets must be at least 129 and at most the context
  size minus 24 reserved output tokens for meeting, or the full context size for
  effort. Invalid budgets return `invalid_budget`. No field means no truncation;
  an over-context input without a budget still returns `input_too_long`.
- Replies after accepted input validation include `originalPromptTokens`,
  `usedPromptTokens`, `promptTokens` (the existing used-count alias), `inputBudget`
  (null when absent), `inputTruncated`, and `inputTokenFingerprint`. The fingerprint
  is FNV-1a 64 over each used token ID encoded as four unsigned little-endian
  bytes, returned as 16 lowercase hexadecimal digits. It is a parity diagnostic,
  not a cryptographic integrity check. `token_fingerprint.py` supplies the same
  operation for Python replay. Invalid generated meeting output still returns
  this input metadata, without returning the raw generated text.
- Clear all attention and recurrent memory buffers before **and after** each
  request with `llama_memory_clear(llama_get_memory(context), true)`.
- Echo a positive, monotonically increasing integer request ID. Reject duplicate
  or older IDs. The caller must discard replies not matching its pending ID.
- `effort` returns the four first-token logits and their four-way softmax in the
  order `low, medium, high, xhigh`. These are uncalibrated probabilities; `xhigh`
  can contain multiple tokens. This matches the research readout, not a claim
  that a single-token score is the probability of the complete label.
- `meeting` generates greedily for at most 24 tokens and returns only validated
  participant IDs, or an empty list for `NONE`. Unknown IDs, duplicates, extra
  prose, and truncation fail closed with `invalid_response`.
- Errors use fixed codes and never include model paths, prompts, or raw generated
  text. Upstream logging is suppressed. stdout contains only protocol JSON.
- Cancellation is owned process termination, awaited before replacement. There
  is no concurrent in-band cancellation command or request retry.
- `ready` currently means loaded, **not warmed**. The probe measures the first
  request separately. Production readiness would require a fixed non-sensitive
  warm-up before ready, plus existing lifecycle, packaging, quality, resource,
  cancellation, and independent evaluation gates.

`probe.py` is an opt-in integration probe using synthetic prompts. It checks
repeated A/B/A first-logit fingerprints, four-label readout, meeting output,
invalid requests, stale IDs, privacy of errors, termination during startup and
inference, and short / approximately 350-token timing and Linux RSS.

Build (all arguments are explicit; no repo or vendor downloads):

```sh
python tools/local-intelligence/research/gguf-helper/build.py \
  --llama-dir /path/to/pinned/llama.cpp --output /private/path/gguf-helper
python tools/local-intelligence/research/gguf-helper/probe.py \
  --helper /private/path/gguf-helper --model /private/path/model.gguf \
  --tokenizer /private/path/tokenizer --out /private/path/probe.json
```

Requests:

```json
{"id":1,"op":"effort","prompt":"already formatted SFT prompt"}
{"id":2,"op":"meeting","prompt":"already formatted SFT prompt","participantIds":["p1","p2"]}
{"id":3,"op":"effort","prompt":"long already formatted SFT prompt","inputBudget":1024}
```

The existing executable invocation `gguf-helper MODEL THREADS CONTEXT` keeps CPU
behavior. An optional final `--backend cpu` or `--backend gpu` selects the backend
explicitly. GPU mode uses the linked Vulkan device with full model-layer offload,
fails at startup when no GPU is available, and does not fall back to CPU. GPU
runtime behavior requires a separately coordinated smoke test; the CPU probe
does not authorize GPU execution.

Build requirements: C++17 compiler, the already built libllama and ggml shared
libraries, and llama.cpp's existing vendored nlohmann JSON 3.12.0 header (MIT). No npm package
or copied third-party source is added. This prototype pins llama.cpp commit
`a91eab67d8389d979d29fdf6633b2edd0718eb4b` (`0.8.0-dev`, MIT); the build refuses a
different checkout. The local library build is native to this development host
and is not a portable release artifact.

## Runtime choice for this experiment

Use this small subprocess for the frozen GGUF replay. It reuses the already
pinned native build, accesses the exact first-token logits, explicitly clears
both recurrent and attention buffers, and fits the existing owned-process
boundary. This recommendation is about integration scope, not demonstrated
speed relative to a Node binding.

[node-llama-cpp 3.22.2](https://github.com/withcatai/node-llama-cpp/tree/v3.22.2)
is a viable mature alternative: MIT, Node >=20, native platform packages and
CPU/Metal/CUDA/Vulkan support. Its
[controlledEvaluate API](https://node-llama-cpp.withcat.ai/api/classes/LlamaContextSequence)
can return selected logits, so the four-label readout does not require a new
classification head. Its
[native sequence disposal](https://github.com/withcatai/node-llama-cpp/blob/v3.22.2/llama/addon/AddonContext.cpp)
uses `llama_memory_seq_rm`; that path would need its own repeated-input tests
with this recurrent model. This is not evidence that the Node package drifts.

The published package declares 28 required dependencies and 14 optional
platform/backend packages, and its main archive is about 40.4 MB unpacked before
native platform packages and transitive dependencies. Only relevant optional
packages would be installed. It would still need a child-process JSONL wrapper
to retain kill-based cancellation and native-crash isolation. None of those
packages was installed or runtime-benchmarked in this experiment. The source tag
resolves to `10e58c743b93f04f897fe1b9ed105d50c04f880b`.

The direct helper trades that package integration for maintaining approximately
280 lines of C++ and separate platform builds. It does not solve production
packaging, manifest pinning, GPU selection, calibrated confidence, or model
quality. Those remain release gates, along with independent evaluation and the
product's stricter performance target.
