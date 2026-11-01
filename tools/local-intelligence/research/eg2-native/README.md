# Tuned EG2 native research probe

This is a CPU-only export and parity experiment. It does not register a production
backend, change defaults, load models at judgment time, publish artifacts, or open
calibration, policy, final, or outcome data. All generated models, reference vectors,
labels, and reports belong under the private experiment root.

## Existing dependencies and upstream source

- llama.cpp commit `a91eab67d8389d979d29fdf6633b2edd0718eb4b`, MIT. The existing
  source/build is reused without modification. Official conversion support is in
  [`conversion/gemma.py`](https://github.com/ggml-org/llama.cpp/blob/a91eab67d8389d979d29fdf6633b2edd0718eb4b/conversion/gemma.py),
  and the noncausal graph is in
  [`src/models/gemma-embedding2.cpp`](https://github.com/ggml-org/llama.cpp/blob/a91eab67d8389d979d29fdf6633b2edd0718eb4b/src/models/gemma-embedding2.cpp).
- The existing training environment pins PyTorch 2.15.0 and Transformers 5.22.1 in
  `../../training-requirements.txt`; safetensors and the upstream converter's Python
  dependencies are already installed there. No additional runtime dependency is added.
- The base model is `google/embeddinggemma-2` revision
  `f9972ac22e696a105c482202646979e33e4b5a1e`. Its cached official model card declares
  Apache-2.0: [model card](https://huggingface.co/google/embeddinggemma-2/tree/f9972ac22e696a105c482202646979e33e4b5a1e).
- JSON parsing uses llama.cpp's existing nlohmann/json 3.12.0 header (MIT).

## Export and input contract

`export.py` restores the original text-only composite wrapper around the tuned
`EmbeddingGemma2TextModel`: `vision_config` and `audio_config` remain null, text
parameters are retained, and each tensor receives only a `language_model.` name
prefix. The text sub-config's architecture override is removed so the official
converter selects `EmbeddingGemma2Model`. Every reloaded tensor is checked bit for
bit against the source; no tensor is reinitialized or adjusted.

The head is exported exactly as FP32 LayerNorm (epsilon `1e-5`), Linear 768→64,
GELU with the erf definition, and Linear 64→4. Evaluation dropout is disabled.
The label order is low, medium, high, xhigh; the helper returns logits and argmax,
not a calibrated confidence or a product action.

Input text is the existing structured F effort `row.text`. Both reference and
helper add exactly `task: classification | query: `, then tokenize with BOS/EOS.
Following the actual structured training `train.py:pack` path, an over-budget
sequence retains its first 128 token IDs and its final `budget-128` IDs after
full special-token encoding. This is distinct from the shipped frozen LiteRT
experiment's right truncation. The default budget is 1024, with explicit requests
accepted from 129 through 1024. No character clipping or chat frame is applied.

The helper sets `embeddings=true`, noncausal mean pooling, and
`n_batch=n_ubatch=1024`. Each request is one complete bidirectional graph; splitting
it into independent 512-token prefills changes its meaning. The 768D pooled vector
is L2-normalized before the exported head. Any memory object is cleared before and
after each request. A/B/A equality is tested separately from model accuracy.

## Run locally

Set `EG2_ROOT` to the private experiment directory and `EG2_PY` to its existing
training Python executable. All arguments below are local paths; no downloads occur.

```sh
"$EG2_PY" tools/local-intelligence/research/eg2-native/test_export.py
"$EG2_PY" tools/local-intelligence/research/eg2-native/export.py \
  --source "$EG2_ROOT/models/encoder-curve-v2/effort-eg2-full-ce" \
  --output "$EG2_ROOT/models/eg2-native/fold0/wrapped"
"$EG2_PY" "$EG2_ROOT/vendor/llama.cpp/convert_hf_to_gguf.py" \
  "$EG2_ROOT/models/eg2-native/fold0/wrapped" --outtype f16 \
  --outfile "$EG2_ROOT/models/eg2-native/fold0/encoder-f16.gguf"
"$EG2_ROOT/vendor/llama.cpp/build/bin/llama-quantize" \
  "$EG2_ROOT/models/eg2-native/fold0/encoder-f16.gguf" \
  "$EG2_ROOT/models/eg2-native/fold0/encoder-q8.gguf" Q8_0 4
"$EG2_ROOT/vendor/llama.cpp/build/bin/llama-quantize" \
  "$EG2_ROOT/models/eg2-native/fold0/encoder-f16.gguf" \
  "$EG2_ROOT/models/eg2-native/fold0/encoder-q4.gguf" Q4_K_M 4
"$EG2_PY" tools/local-intelligence/research/eg2-native/build.py \
  --llama-dir "$EG2_ROOT/vendor/llama.cpp" \
  --output "$EG2_ROOT/runs/eg2-native/eg2-helper"
"$EG2_PY" tools/local-intelligence/research/eg2-native/probe.py hf --root "$EG2_ROOT"
"$EG2_PY" tools/local-intelligence/research/eg2-native/probe.py f16 --root "$EG2_ROOT"
"$EG2_PY" tools/local-intelligence/research/eg2-native/probe.py q8 --root "$EG2_ROOT"
"$EG2_PY" tools/local-intelligence/research/eg2-native/probe.py q4 --root "$EG2_ROOT"
"$EG2_PY" tools/local-intelligence/research/eg2-native/latency.py --root "$EG2_ROOT" --kind q8
```

`probe.py` reads only `fit.jsonl` and the checkpoint's `run.json` group membership.
It compares the original and wrapped HF FP32 outputs, exact native/HF token IDs,
embedding cosine/error, independently computed head math, prediction agreement,
and F-dev accuracy. It includes an explicit over-budget synthetic case, A/B/A,
clean EOF, artifact hashes, peak process RSS, and CPU latency. Its full vectors and
token IDs are private diagnostics and must not be copied into application logs.
`latency.py` separately measures synthetic 64/128/256/512/1024-token requests,
exact repeated logits, malformed/duplicate-request recovery, and EOF.

The helper protocol is one JSON line per request:
`{"id":1,"text":"Inspect the function.","inputBudget":1024}`.
IDs must increase. Replies include ID, original/used token IDs, normalized embedding,
four logits, label index, and elapsed milliseconds. Errors use fixed codes without
input or path strings. EOF exits cleanly. The caller owns process cancellation.

`build.py` deliberately uses the already built host libraries and their absolute
rpath. This helper is not a portable release artifact; portability, GPU performance,
combined-role memory residency, other folds, calibration, and final quality remain
separate gates. CPU timings include ordinary host contention and are not an isolated
machine benchmark.
