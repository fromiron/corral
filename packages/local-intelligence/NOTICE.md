# @corral/local-intelligence — notices

## Effort classifier weights (`weights/effort-v1.json`)

A linear classifier trained by Corral on embeddings of text from these datasets
(`tools/local-intelligence/effort/datasets.md` lists the pinned revisions):

- MATH, Hendrycks et al. (`EleutherAI/hendrycks_math`), MIT License.
- GSM8K, OpenAI (`openai/gsm8k`), MIT License.
- MMLU, Hendrycks et al. (`cais/mmlu`), MIT License.
- MMMLU, OpenAI (`openai/MMMLU`), MIT License.
- TACO, BAAI, Shandong Normal University and Peking University (`BAAI/TACO`), Apache License 2.0;
  it includes material under the MIT License and web-crawled material used under CC BY 4.0
  (<https://creativecommons.org/licenses/by/4.0/>). HackerRank problems were not used.
- CommitPackFT, BigCode (`bigcode/commitpackft`), MIT License; commit subjects from permissively
  licensed repositories.
- SWE-rebench, Nebius (`nebius/SWE-rebench`), CC BY 4.0
  (<https://creativecommons.org/licenses/by/4.0/>); GitHub issue texts and the size of the patches
  that resolved them.

No dataset text is included in this package.

The `effort-v2` weights also use authored multilingual coding scenarios in
`tools/local-intelligence/effort/curriculum.tsv`. These additions are original project material
under the repository's MIT license; they are synthetic, not private user logs.

## Downloaded at install time, not part of this package

`corral local-ai install` downloads the files pinned in `src/bundle.json` and checks each file's
size and sha256:

- EmbeddingGemma 2 Text 270M for LiteRT-LM
  (<https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm>, revision
  `9be6e8b90982095dc05c2bd162e4b954ee4dbac7`), Copyright Google, Apache License 2.0.
- Corral Effort Judge 270M, int8
  (<https://huggingface.co/fromiron/corral-effort-judge-270m>, revision
  `c772d41e5ae7f5bdf6e31b381b8044a4211d5fd9`), Apache License 2.0. This is a modified
  version of Google's EmbeddingGemma 2 text encoder, fine-tuned and quantized for Corral.
  Its classification heads are included in `weights/effort-v4.json`.
- The LiteRT-LM C library from the `litert-lm-api` 0.19.0 wheel on PyPI
  (<https://github.com/google-ai-edge/LiteRT-LM>), Copyright Google, Apache License 2.0. On Windows
  the wheel's `dxcompiler.dll` and `dxil.dll` (Microsoft DirectX Shader Compiler) are installed next
  to it.

## The helper (`helper/`)

Built from source in this repository. Its Rust dependencies are pinned in `helper/Cargo.lock`:
libloading (ISC), serde and serde_json (MIT OR Apache-2.0).
