# P0 스파이크: 로컬 임베딩 런타임 선택

제품 빌드에 포함하지 않는 측정용 코드다. EmbeddingGemma 2 Text 270M을 Corral 서버에서 어떤 런타임으로 실행할지 실측으로 정하는 것이 목적이다. 결정이 나면 이 디렉터리는 근거 기록으로만 남는다.

## 비교한 후보

| 후보 | 구성 | 모델 파일 |
|---|---|---|
| **A** | LiteRT-LM 공식 C 라이브러리(`liblitert-lm`, PyPI `litert-lm-api` 0.19.0 휠에 포함) + Rust 상주 헬퍼. stdin/stdout JSON 줄 프로토콜, 네트워크 리스너 없음 | `litert-community/embeddinggemma-2-text-270m-litert-lm` @ `9be6e8b9` `embeddinggemma-2-text-270m.litertlm` (164,626,432 B, sha256 `2d079ee2…86fb`), Google QAT int4 |
| **B** | onnxruntime-node 1.30.0(현재 번들됨)를 Node 프로세스 안에서 실행 | `onnx-community/embeddinggemma-2-ONNX` @ `daa72c51` `onnx/model_q4.onnx`(+data 174 MB), 커뮤니티 후처리 q4. `model_quantized`(int8)도 비교 |

LiteRT-LM 공식 `litert-lm serve`는 Python 3.10+가 필요하고 기본 `0.0.0.0`에 인증 없이 열리므로 처음부터 제외했다. LiteRT-LM의 JS SDK는 브라우저 전용이라 Node에서 쓸 수 없다.

## 측정 환경

- AMD Ryzen 5 5600X (6코어 12스레드, AVX2), 31 GiB, NVIDIA RTX 3070 (Vulkan), Arch Linux 커널 7.2.11
- Node 24.14.0, rustc 1.97.1, 참조용 Python 3.13.11(uv)
- warm 상태에서 같은 입력을 20회 반복한 p50/p95. A는 Node가 요청을 보내고 응답을 받기까지의 전체 시간(IPC 포함)이다.
- 입력은 `fixtures/texts.json`이다. 한·일·영·코드 혼합 요청을 짧게(15~62토큰), 중간(222~245토큰), 길게(538~561토큰) 만들었다. 접두어는 Google 모델 카드의 `task: classification | query: `를 쓴다.

## 결과

### 지연 (ms, p50 범위 / 해당 구간 최대 p95)

| 구성 | 짧음 | 중간 | 김 | 로드 | 상주 RSS |
|---|---|---|---|---|---|
| A CPU 기본(4스레드), 입력 상한 없음 | 75–80 / 92 | 159–163 / 184 | 881–896 / 957 | 220 | 517 MiB |
| A CPU 4스레드, 상한 256토큰 | 78–80 / 85 | 161–163 / 168 | 160–162 / 165 | 165 | 322 MiB |
| **A CPU 6스레드, 상한 256토큰** | **58–61 / 68** | **115–117 / 123** | **116–120 / 131** | 154 | 323 MiB |
| A CPU 6스레드, 상한 512토큰 | 58–61 / 67 | 113–127 / 147 | 255–260 / 288 | 189–518 | 408 MiB |
| A CPU 2스레드, 상한 512토큰 | 141–143 / 143 | 300 / 304 | 676 / 683 | 599 | 408 MiB |
| **A GPU(RTX 3070), 상한 256토큰** | **9–10 / 10** | **13 / 14** | **13–14 / 14** | 2,223(캐시) / 3,122(첫 실행) | 451 MiB (최대 491) |
| B CPU 4스레드 q4 | 24–60 / 61 | 202–223 / 225 | 571–591 / 596 | 204 | 369 MiB(Node 전체) |
| **B CPU 6스레드 q4** | **18–45 / 47** | **141–160 / 165** | **406–424 / 431** | 208 | 373 MiB(Node 전체) |
| B CPU 12스레드 q4 | 38–45 / 65 | 162–176 / 300 | 442–467 / 513 | 229 | 372 MiB |
| B CPU 6스레드 int8 | 76–83 / 87 | 189–209 / 225 | 436–461 / 482 | 94 | 469 MiB |

- A는 입력을 128/256/512/1024… 토큰 구간으로 패딩한다. 그래서 짧은 입력도 128토큰 비용이 들고, 512토큰을 조금 넘으면 1024 구간으로 가서 지연이 크게 늘어난다. 입력 상한(`max_input_length`)과 잘라내기 전략으로 구간을 고정할 수 있다.
- B는 패딩이 없어 짧은 입력이 빠르다. 대신 토큰당 비용이 A보다 커서 중간 길이부터는 A가 빠르다.
- 두 후보 모두 물리 코어 수(6)에서 가장 빨랐다. 논리 코어 전체(12)는 오히려 느리다.
- A의 IPC 오버헤드는 요청당 0.12–0.34 ms다.
- 16건 배치: A CPU 6스레드 946 ms, A GPU 144 ms. 배치로 처리해도 건당 비용은 단건과 거의 같다.
- 두 요청을 동시에 보내면 A 헬퍼는 차례로 처리한다(CPU 114 ms, GPU 18 ms).
- 헬퍼 종료: CPU 35–41 ms, GPU 260–313 ms.
- A GPU는 `cache_dir`을 지정하면 셰이더·가중치 캐시(약 74 MB)를 남긴다. 두 번째 로드는 3.3초에서 2.5초로, 첫 추론은 87 ms에서 15 ms로 줄었다.

### 임베딩 일치도 (코사인)

| 비교 | 중앙값 | 최소 |
|---|---|---|
| A CPU vs A GPU | 0.9974 | 0.9889 |
| A(LiteRT) vs B(ONNX q4) | 0.968 | 0.948 |
| B q4 vs B int8 | 0.983 | 0.969 |

- A와 B는 양자화가 달라 임베딩이 서로 바꿔 쓸 수 있을 만큼 같지 않다. 분류기는 실제 실행할 런타임과 같은 임베딩으로 학습해야 한다.
- 같은 A라도 CPU와 GPU는 미세하게 다르다. 분류기는 두 장치 모두에서 검증해야 한다.

### 플랫폼

| 타깃 | A: `litert-lm-api` 0.19.0 휠의 C 라이브러리 | B: onnxruntime-node 1.30.0 | 이 머신에서 실행 확인 |
|---|---|---|---|
| linux-x64 | 있음 (`liblitert-lm.so` 85 MB, libc 외 의존성 없음) | 있음 | A CPU·GPU(Vulkan), B CPU |
| linux-arm64 | 있음 (85 MB) | 있음 | 아니오 |
| darwin-arm64 | 있음 (`liblitert-lm.dylib` 51 MB) | 있음 | 아니오 |
| darwin-x64 | **휠 없음** | 현재 코드에서 미지원(`onnxRuntimeSupported`) | — |
| win-x64 | 있음 (`litert-lm.dll` 53 MB + D3D12용 `dxcompiler.dll`·`dxil.dll`, OpenVINO NPU dispatch) | 있음 (+DirectML) | 아니오 |
| win-arm64 | **휠 없음** | 있음 | 아니오 |

- A의 GPU 가속기(WebGPU/Dawn)는 라이브러리에 정적으로 링크돼 있다. Linux에서는 Vulkan으로 RTX 3070을 선택해 동작했다. Windows(D3D12)와 macOS(Metal)는 휠 구성과 공식 문서로만 확인했다.
- B의 현재 패키징은 postinstall을 막아 CPU 실행만 된다. Linux·macOS GPU는 쓸 수 없다.

### 그 밖의 사실

- **C API 버전 고정이 필수다.** 0.18.1 라이브러리는 같은 헬퍼로 `embedding_engine_settings_create`가 잘못된 상태값을 돌려줬다(ABI 불일치). 0.19.0부터 export가 버전 태그(`LITERT_LM_C_API_1.0`)가 붙은 228개로 정리됐고 `litert_lm_get_api_version`이 생겼다. 헬퍼는 시작할 때 이 값을 확인해야 한다.
- PyPI 0.19.0(2026-10-28 게시)에 대응하는 GitHub 태그는 아직 없다. 저장소 `main`의 `version.bzl`은 `0.19.0`이다. 정적 링크된 서드파티 고지는 대응 소스에서 모아야 한다.
- 진행 중인 임베딩 계산을 취소하는 C API는 없다. 취소는 결과를 버리는 방식으로 처리하고, 장치 변경이나 종료 때는 헬퍼 프로세스를 끝낸다.
- 작업 접두어가 문서마다 다르다. LiteRT-LM 문서는 `task: classification | text:`, Google 모델 카드와 `config_sentence_transformers.json`은 `task: classification | query: `다. 모델 카드를 따른다.
- 출력 차원은 768이고 128/256/512로 줄일 수 있다(Matryoshka). 컨텍스트는 8K 토큰이다. 모델과 런타임 모두 Apache-2.0이다.
- 측정 중 헬퍼가 준비 전에 종료되면 드라이버가 응답을 무한히 기다렸다. 제품 어댑터는 준비 전 종료를 실패로 처리해야 한다.

## 권장안: A (LiteRT-LM C 라이브러리 + Rust 상주 헬퍼)

1. **실제 판정 입력 길이에서 더 빠르다.** effort 입력은 이전 요청·응답·도구 결과를 포함해 대체로 128토큰을 넘는다. 256토큰 상한에서 A CPU는 p95 131 ms 이하, B는 같은 길이에서 p95 165 ms다.
2. **GPU 경로가 바로 동작한다.** RTX 3070에서 p95 14 ms였다. B는 현재 패키징으로 Linux·macOS GPU를 쓸 수 없다.
3. **공식 모델을 그대로 쓴다.** Google QAT int4 파일을 쓰고, 커뮤니티 변환본에 의존하지 않는다.
4. **서버와 분리된다.** 네이티브 크래시가 서버를 죽이지 않고, 장치 변경과 종료는 프로세스 종료로 확실히 끝난다. IPC 비용은 0.3 ms 미만이다.
5. **사용자 환경에 Python이 필요 없다.**

감수할 점:
- darwin-x64와 win-arm64에서는 로컬 AI를 쓸 수 없다. darwin-x64는 지금의 ONNX judge도 지원하지 않는다. 이 타깃에서 자동 추론은 지금처럼 medium으로 fallback한다.
- 짧은 입력도 128토큰 비용(CPU 6스레드 약 60 ms)이 든다.
- 상주 메모리가 약 320 MiB(256토큰 상한, CPU)~450 MiB(GPU)다.
- 헬퍼를 플랫폼별로 빌드해야 한다. 빌드 호스트와, 개발 중 로컬 AI를 쓰려면 Rust 도구 체인이 필요하다.

## 승인받을 결정

1. 런타임은 A로 한다.
2. effort 판정 입력은 256토큰으로 자르고, CPU 스레드는 물리 코어 수(최대 6)로 한다.
3. 지연 목표: 기준 머신에서 warm p95가 CPU 150 ms 이하, GPU 20 ms 이하. 이 머신의 실측값은 131 ms, 14 ms다.
4. 배포 방식
   - `liblitert-lm`은 설치할 때 모델과 함께 받는다. 휠 sha256과 추출 파일 sha256을 manifest에 고정한다. 데스크톱 설치 파일에는 넣지 않는다.
   - 헬퍼는 저장소의 Rust 크레이트를 호스트별로 빌드해 데스크톱 `prepare` 단계에서 번들한다(0.5 MB).
5. 네이티브 의존성 기록
   - Cargo 의존성은 `Cargo.lock`에 정확히 고정하고, `tools/deps`가 이름·버전·라이선스를 기록하고 검사하도록 확장한다.
   - LiteRT-LM 휠은 `docs/dependency-lock.json`의 `reviewedSources`에 남긴다.

## 이번에 확인하지 못한 것

- linux-arm64, macOS, Windows에서 실제 실행
- 다른 CPU(코어 수, AVX-512, ARM)에서의 지연과 스레드 수 기준
- GPU 초기화 실패 처리(드라이버 없음, 원격 세션)
- 회의 분석 처리량. CPU에서 긴 발언은 건당 250 ms 안팎이므로 50건이면 수 초가 걸린다. P4의 시간 상한과 캐시 설계에 반영해야 한다.

## 재현

```bash
node fixtures/build.ts
uv run --no-project --python 3.13 --with litert-lm-api==0.19.0 python reference/litert_reference.py <model.litertlm> <out.json> cpu 6
(cd litert-helper && cargo build --release)
node bench/helper-bench.ts litert-helper/target/release/corral-litert-helper-spike <liblitert-lm.so> <model.litertlm> cpu 6 256 <out.json> [cache_dir]
node bench/onnx-bench.ts <onnx-dir> <tokenizer-dir> model_q4 <out.json> 6
node bench/compare.ts <a.json> <b.json>
```

`liblitert-lm.so`는 `litert_lm_api-0.19.0-py3-none-manylinux_2_27_x86_64.whl`(sha256 `c5a8a953…be76`)에서 꺼낸다. ONNX 벤치의 토크나이저 디렉터리에는 `onnx-community/embeddinggemma-2-ONNX`의 `tokenizer.json`을 둔다(이 스크립트가 같은 디렉터리에 `tokenizer.bin` 캐시를 쓴다). 내려받은 파일과 측정 결과는 저장소 밖에 둔다. `onnx-bench.ts`는 이후 제거된 `packages/effort-judge`의 토크나이저와 onnxruntime-node를 쓴다. 다시 돌리려면 그 패키지가 남아 있는 커밋 `2b3c0ed9`에서 실행한다.
