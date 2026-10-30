# @corral/local-intelligence — notices

## Code derived from Mixdog — Apache License 2.0

The install-then-stamp approach in `src/install.ts` and the single-slot occupancy rule in
`src/engine/engine.ts` are derived from Mixdog (<https://github.com/tribgames/mixdog>,
`src/runtime/effort-judge/`), licensed under the Apache License 2.0 (`LICENSE-Apache-2.0.txt`).

Statement of changes (Apache-2.0 section 4(b)): ported to TypeScript; downloads are streamed with
cancellation and progress; the runtime library is extracted from a pinned wheel; each release is
installed into its own folder; inference runs in a separate helper process with an effort-first
queue instead of a worker thread.

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
