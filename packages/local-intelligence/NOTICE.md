# @corral/local-intelligence — notices

## Downloaded at install time, not part of this package

`corral local-ai install` downloads the files pinned in `src/bundle.json` and checks each file's
size and sha256:

- EmbeddingGemma 2 Text 270M for LiteRT-LM
  (<https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm>, revision
  `9be6e8b90982095dc05c2bd162e4b954ee4dbac7`), Copyright Google, Apache License 2.0.
- The LiteRT-LM C library from the `litert-lm-api` 0.19.0 wheel on PyPI
  (<https://github.com/google-ai-edge/LiteRT-LM>), Copyright Google, Apache License 2.0. On Windows
  the wheel's `dxcompiler.dll` and `dxil.dll` (Microsoft DirectX Shader Compiler) are installed next
  to it.

## The helper (`helper/`)

Built from source in this repository. Its Rust dependencies are pinned in `helper/Cargo.lock`:
libloading (ISC), serde and serde_json (MIT OR Apache-2.0).
