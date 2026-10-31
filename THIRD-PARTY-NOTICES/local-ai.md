# Local AI model and runtime

`@corral/local-intelligence` replaced the earlier ONNX effort judge. The app does not bundle the model or the runtime library: `corral local-ai install` (or the settings panel) downloads them into the user's data directory from the URLs pinned in `packages/local-intelligence/src/bundle.json`, and checks each file's size and sha256.

| Item | Pinned version | License | Source |
|---|---|---|---|
| EmbeddingGemma 2 Text 270M for LiteRT-LM | revision `9be6e8b90982095dc05c2bd162e4b954ee4dbac7` | Apache-2.0 (model card), Google | https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm |
| LiteRT-LM C library from the `litert-lm-api` wheel | 0.19.0 | Apache-2.0 (wheel metadata), Google | https://github.com/google-ai-edge/LiteRT-LM |
| `dxcompiler.dll`, `dxil.dll` (Windows only, same wheel) | as shipped in the 0.19.0 wheel | Microsoft DirectX Shader Compiler; the wheel carries no separate license file for them and their terms were not reviewed separately | https://github.com/microsoft/DirectXShaderCompiler |

- The Rust helper that loads the library is built from `packages/local-intelligence/helper`. Its direct dependencies are pinned in `helper/Cargo.lock`: libloading 0.8.8 (ISC), serde 1.0.219 and serde_json 1.0.140 (MIT OR Apache-2.0). The desktop runtime ships the helper built on the packaging host. The license texts of every locked crate are in `local-ai-helper-crates.txt`; regenerate it with `node tools/local-intelligence/helper-notices.ts` after changing the lock.
- The effort classifier weights in `packages/local-intelligence/weights/` were trained on public datasets; their attribution is in `packages/local-intelligence/NOTICE.md`.
- Code derived from Mixdog (Apache-2.0) and its statement of changes are in `packages/local-intelligence/NOTICE.md` and `LICENSE-Apache-2.0.txt`.
