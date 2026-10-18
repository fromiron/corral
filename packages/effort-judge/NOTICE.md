# @corral/effort-judge — notices

## Code derived from Mixdog — Apache License 2.0

`src/tokenizer.ts`, `src/install.ts`, `src/input.ts`, `src/cost.ts`, `src/onnx-worker.ts` and
parts of `src/provider.ts` are derived from Mixdog (<https://github.com/tribgames/mixdog>,
`src/runtime/effort-judge/` and `src/runtime/agent/orchestrator/providers/auto-effort.mjs`),
licensed under the Apache License 2.0 (`LICENSE-Apache-2.0.txt`).

Statement of changes (Apache-2.0 section 4(b)): ported to TypeScript; tokenizing moved out of the
worker thread (the worker only runs the model); the bounded download and `installState` are
written inline instead of Mixdog's shared helpers and only HTTPS manifests are accepted; Corral
keeps observe-only excerpts and adds CR-021 turn/tool-step inputs, bounded inference, cancellation, and Coordinator permit application. The shared expected-cost rule now lives in `../contracts/src/reasoning-cost.ts`. Step formatting follows Mixdog commit `81558aa4230744e504972e01cb248ec9369e35bc`.

## The effort judge model (downloaded, not part of this package)

`corral judge install` downloads the model from the Mixdog `effort-judge-v6` GitHub release named
in `src/model-manifest.json` and checks each file's size and sha256. The model is not bundled.

The model is derived from EmbeddingGemma 2 (Copyright (c) Google,
<https://huggingface.co/google/embeddinggemma-2>), licensed under the Apache License 2.0
(`LICENSE-Apache-2.0.txt`). Changes: only the text encoder is kept, reduced to 18 of its layers;
a four-level classification head is added and the model is fine-tuned to rate the reasoning
effort a request or an agent step needs; the weights are exported to ONNX and quantized to 4 bits.

Its training data includes requests and agent steps from SWE-chat
(<https://huggingface.co/datasets/SALT-NLP/SWE-chat>, Open Data Commons Attribution License 1.0);
OpenAssistant oasst2 (<https://huggingface.co/datasets/OpenAssistant/oasst2>, Apache License
2.0); WildChat (<https://huggingface.co/datasets/allenai/WildChat-4.8M>, Open Data Commons
Attribution License 1.0); DataClaw exports published under the MIT License
(<https://huggingface.co/datasets/di-zhang-fdu/ShareDataClaw>); DevGPT by Tao Xiao, Christoph
Treude, Hideaki Hata and Kenichi Matsumoto (<https://doi.org/10.5281/zenodo.16392320>, CC BY
4.0); issue texts from the SWE-bench training split (<https://github.com/SWE-bench/SWE-bench>,
MIT License); and agent steps from NVIDIA's SWE-Hero OpenHands trajectories
(<https://huggingface.co/datasets/nvidia/SWE-Hero-openhands-trajectories>, CC BY 4.0).

(Attribution text as provided by Bell on 2026-10-16 from the Mixdog release notes. Mixdog's own
NOTICE.md for an earlier judge release states 12 layers; the v6 calibration.json states
"EmbeddingGemma 2 (18 layers)", which matches the text above.)

## onnxruntime-node — MIT

Runtime for the model, installed from npm (`onnxruntime-node` 1.30.0, MIT,
<https://github.com/microsoft/onnxruntime>). Its CPU binaries ship in the npm package; the
postinstall script, which only fetches optional GPU builds, is not run (pnpm-workspace.yaml).
