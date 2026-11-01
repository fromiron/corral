# Local decision helper: Linux x64 prototype

This socket-free JSON-lines executable links the pinned llama.cpp C API. The
TypeScript controller in `src/decision/engine.ts` owns its process lifetime.
It is not selected by the default factory, included in an installation manifest,
or a portable desktop release artifact. Judgment never downloads a runtime or
model. CPU and Vulkan were exercised on one Linux x64 development machine;
Windows, macOS, other architectures, and packaged desktop execution are unverified.

## Pinned build inputs

- [llama.cpp](https://github.com/ggml-org/llama.cpp/tree/a91eab67d8389d979d29fdf6633b2edd0718eb4b):
  commit `a91eab67d8389d979d29fdf6633b2edd0718eb4b`, reported version
  `0.8.0-dev`, [MIT license](https://github.com/ggml-org/llama.cpp/blob/a91eab67d8389d979d29fdf6633b2edd0718eb4b/LICENSE).
- The upstream tree's existing [nlohmann JSON header](https://github.com/ggml-org/llama.cpp/blob/a91eab67d8389d979d29fdf6633b2edd0718eb4b/vendor/nlohmann/json.hpp):
  version `3.12.0`, MIT. No third-party source copy is vendored here.
- C++17 compiler, Python 3, Git, the matching llama/ggml headers, and already built
  shared libraries in that checkout's `build/bin`. Vulkan builds additionally
  require a compatible system Vulkan loader and GPU driver at runtime.
- The controller has no new Node package or peer dependency. It uses the existing
  `HelperLauncher` contract; this repository requires Node `^24.15.0`.

Build explicitly from existing local inputs:

```sh
python packages/local-intelligence/decision-helper/build.py \
  --llama-dir /path/to/pinned/llama.cpp \
  --output /private/build/corral-local-decision-helper
```

The script checks the source revision, restricts this prototype to Linux x64,
and compiles with `-Wall -Wextra -Werror`. Its absolute library rpath and the
development checkout's native CPU build are suitable for local verification,
not artifact publication. It neither builds nor downloads llama.cpp.

## Protocol and readiness

Invoke `HELPER MODEL THREADS CONTEXT [--backend cpu|gpu]`. Omitted backend means
CPU. Thread count is 1–6; context is 128–4096 tokens. GPU selection does not
silently retry CPU. stdout contains only JSON lines; upstream logs are suppressed.

Native `ready` means the model/context loaded. Only after every caller-supplied
fixed non-sensitive warmup input succeeds does `LocalDecisionEngine` report
`ready`. Warmup inputs must exercise the intended prefill/decode shapes; one
successful warmup does not establish coverage of every backend kernel path.

Each request has a positive increasing integer `id`, `op` (`effort` or `meeting`),
the exact preformatted thinking-disabled `prompt`, and optional `inputBudget`.
Meeting additionally requires `participantIds`. Explicit budgets of at least
129 retain the first128 and final `budget−128` token IDs when needed. The budget
cannot exceed context minus24 for meeting or context for effort. Omitted budget
means no truncation. Over-context input fails explicitly.

The helper clears attention and recurrent data before and after each request
with `llama_memory_clear(memory, true)`. Effort returns distinct label first-token
logits and their four-way softmax, ordered low/medium/high/xhigh. These scores
are uncalibrated; xhigh may contain multiple tokens. Meeting greedily generates
at most24 tokens and returns only unique, registered IDs or an empty list for
NONE. Invalid output returns a fixed error code, never raw generated prose.

Accepted inputs include original/used token counts, explicit budget, truncation
status, and an FNV-1a64 fingerprint of used IDs encoded as little-endian uint32.
This is a tokenizer parity diagnostic, not a cryptographic integrity check.
The controller checks the expected protocol/backend, budgets, score dimensions,
softmax consistency, and recipient membership. It never sends cancellation
commands into the inference stream: active cancellation kills and awaits its
owned process. Old process callbacks and unmatched IDs cannot settle new work.
The caller remains responsible for attempt/revision/idempotency and calibrated
policy decisions; failed requests are not automatically replayed.

The Qwen3.5 caller applies its trained tokenizer's NFC normalization before
native tokenization. The pinned llama.cpp BPE path does not apply that HF
normalizer itself. This only changes the judgment copy, not source messages or
files. Native/HF token-ID parity includes decomposed accents and Hangul.

## Required publication integration

The artifact owner must record helper and every shipped shared-library byte
size/hash, upstream revision, supported OS/arch/CPU ISA, license notices, loader
layout, model identity/hash, tokenizer/preprocessing/input-budget contract,
warmup inputs, and role-specific release/calibration identities. The existing
installer's verified-completion boundary must finish before supplying a command
to this controller. Record native dependency evidence through the repository's
dependency-governance tooling and `docs/dependency-lock.json`; no such runtime
manifest/default installation change is made here. Do not infer model promotion
from protocol tests or from a development-machine binary.

Ordinary CI uses fake helpers in `test/decision-engine.test.ts`. Real-model
research probes are explicit opt-in and stay outside ordinary CI; see the
research helper's parity and resource probes. No live teacher call is needed.
