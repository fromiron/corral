# Local AI model and runtime

`@corral/local-intelligence` runs meeting analysis. The app does not bundle the model or the runtime library: `corral local-ai install` (or the settings panel) downloads them into the user's data directory from the URLs pinned in `packages/local-intelligence/src/bundle.json`, and checks each file's size and sha256.

| Item | Pinned version | License | Source |
|---|---|---|---|
| EmbeddingGemma 2 Text 270M for LiteRT-LM | revision `9be6e8b90982095dc05c2bd162e4b954ee4dbac7` | Apache-2.0 (model card), Google | https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm |
| LiteRT-LM C library from the `litert-lm-api` wheel | 0.19.0 | Apache-2.0 (wheel metadata), Google | https://github.com/google-ai-edge/LiteRT-LM |
| `dxcompiler.dll`, `dxil.dll` (Windows only, same wheel) | as shipped in the 0.19.0 wheel | Microsoft DirectX Shader Compiler; the wheel carries no separate license file for them and their terms were not reviewed separately | https://github.com/microsoft/DirectXShaderCompiler |

The Local effort routing engine is installed the same way, only from the settings panel, into its own folder, from the values pinned in `packages/local-intelligence/src/d1/manifest.ts`. Corral starts the downloaded server itself and does not modify either artifact.

| Item | Pinned version | License | Source |
|---|---|---|---|
| LiquidAI d1-2B, `d1-2B-Q4_K_M.gguf` | revision `4a181094d1b6addfaa3a0956f78e7ab2aa406a0c` | LFM Open License v1.0, Liquid AI | https://huggingface.co/LiquidAI/d1-2B-GGUF |
| llama.cpp `llama-server` and its shared libraries, `llama-b12189-bin-ubuntu-x64.tar.gz` | b12189, commit `80d2c0c2c56e4a1bbf74be98f64b99927bf230bc` | MIT, the ggml authors | https://github.com/ggml-org/llama.cpp |
| same llama.cpp build, Vulkan, `llama-b12189-bin-ubuntu-vulkan-x64.tar.gz` (35,871,731 bytes, sha256 `f59bca3239bde0bd2280fde0b538f2abd9e80abc8ccce6c740bb17e630cd6269`) | b12189, commit `80d2c0c2c56e4a1bbf74be98f64b99927bf230bc` | MIT, the ggml authors | https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-vulkan-x64.tar.gz |
| same llama.cpp build, CUDA 12.8, `llama-b12189-bin-ubuntu-cuda-12.8-x64.tar.gz` (188,173,082 bytes, sha256 `664f720005135f621960b8f1550979a1bdd73b8ba887e2a47a314b0154fcaa0a`) | b12189, commit `80d2c0c2c56e4a1bbf74be98f64b99927bf230bc` | MIT, the ggml authors | https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-cuda-12.8-x64.tar.gz |

The Vulkan build needs the system Vulkan loader `libvulkan.so.1`. The CUDA 12.8 build needs the NVIDIA driver (`libcuda.so.1`, Linux driver 570.26 or newer for CUDA 12.8) and the CUDA 12.8 runtime libraries `libcudart.so.12` and `libcublas.so.12`. Corral does not download the release's separate CUDA library archives (`cudart-llama-b12189-bin-ubuntu-cuda-12.8-x64.tar.gz`, 594,371,476 bytes, or the CUDA 13.5 Ubuntu x64 binary and library archives). Those official assets exist; this manifest pins the CUDA 12.8 server archive only. A GPU configuration is not marked verified.

- The Rust helper that loads the library is built from `packages/local-intelligence/helper`. Its direct dependencies are pinned in `helper/Cargo.lock`: libloading 0.8.8 (ISC), serde 1.0.219 and serde_json 1.0.140 (MIT OR Apache-2.0). The desktop runtime ships the helper built on the packaging host. The license texts of every locked crate are in `local-ai-helper-crates.txt`; regenerate it with `node tools/local-intelligence/helper-notices.ts` after changing the lock.
