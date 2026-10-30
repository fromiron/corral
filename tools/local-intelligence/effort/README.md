# effort 분류기 학습

자동 추론의 로컬 판정(`corral-effort-v1`)에 쓰는 선형 분류기를 만든다. 동작 규칙은 [로컬 AI 기능 명세](../../../docs/specs/features/local-intelligence.md)가 정하고, 이 디렉터리는 가중치를 만드는 개발 도구와 그 검증 결과만 둔다. 제품 런타임은 이 디렉터리를 쓰지 않는다.

| 파일 | 내용 |
|---|---|
| [label-rubric.md](label-rubric.md) | 데이터셋의 기존 난이도 신호를 4단계로 옮기는 기준 |
| [datasets.md](datasets.md) | 출처, 고정 리비전, 라이선스, 표본 수, 제외한 것 |
| [fetch.py](fetch.py) | 고정 리비전에서 표본(JSONL)을 만든다 |
| [embed.ts](embed.ts) | 제품 엔진과 전처리로 표본을 임베딩한다 |
| [train.ts](train.ts) | 학습, 온도 보정, 보류 기준 선택, 가중치와 리포트 생성 |
| [report.md](report.md) | `train.ts`가 만든 검증 리포트 |

## 재현

필요한 것: Node 24, [uv](https://docs.astral.sh/uv/)(Python 3.11 이상과 `pyarrow` 26.0.0을 스크립트 머리말에서 고정), Rust 툴체인, 약 600 MB의 디스크(원본 캐시). GPU는 선택이다.

```sh
pnpm --filter @corral/local-intelligence build:helper
pnpm corral local-ai install --data-dir <local-ai-dir>
uv run --no-project tools/local-intelligence/effort/fetch.py <cache-dir> <work>/samples.jsonl
node tools/local-intelligence/effort/embed.ts <work>/samples.jsonl <local-ai-dir> cpu <work>/cpu.f32
node tools/local-intelligence/effort/embed.ts <work>/samples.jsonl <local-ai-dir> gpu <work>/gpu.f32
node tools/local-intelligence/effort/train.ts <work>/samples.jsonl <work>/cpu.f32 <work>/gpu.f32
```

- `<cache-dir>`과 `<work>`는 저장소 밖에 둔다. 원본과 표본은 커밋하지 않는다.
- `fetch.py`는 받은 원본을 출처별 폴더에 캐시한다. TACO는 parquet의 필요한 열만 HTTP 범위 요청으로 읽는다.
- `embed.ts`는 제품과 같은 `effortRequest(requestInput(요청))`으로 한 건씩 임베딩한다. 이 머신(RTX 3070, 6스레드 CPU)에서 16,123건에 GPU 약 3분, CPU 약 18분이 걸렸다.
- `train.ts`는 CPU 벡터로 학습과 보정을 하고, GPU 벡터는 장치 간 일치도만 잰다. 같은 입력이면 결과가 같다. 결과는 `packages/local-intelligence/weights/effort-v1.json`과 `report.md`에 쓴다.

## 절차

1. 분할: 그룹(같은 문제와 그 번역, 같은 저장소의 커밋과 이슈)의 sha256으로 학습 70%, 보정 15%, 테스트 15%를 나눈다. SWE-bench Verified는 평가에만 쓴다.
2. 언어 방향 제거: 한국어·일본어 표본은 low와 medium뿐이라 언어만으로 수준을 맞힐 수 있다. 학습 세트의 MMLU 번역 쌍에서 언어별 평균 차이(ko−en, ja−en)를 구해 모든 벡터에서 그 방향을 뺀다.
3. 학습: 학습 세트로 표준화한 768차원 벡터에 softmax 회귀를 학습한다. 수준마다 같은 비중이 되게 가중하고 L2 계수는 보정 세트 macro-F1로 고른다. 언어 방향 제거와 표준화는 가중치에 접어 넣어 런타임은 원래 벡터에 바로 적용한다.
4. 온도: 보정 세트의 음의 로그 가능도를 최소화하는 온도를 고른다.
5. 보류 기준: 보류한 요청은 medium으로 처리된다고 보고, 보정 세트에서 수준별 가중 평균 수준 오차의 합이 가장 작은 최대 확률 기준을 고른다. 임의 상수를 쓰지 않는다.
6. 가중치 파일을 제품의 `loadEffortClassifier`로 다시 불러 테스트 세트와 평가 세트를 판정하고 리포트를 쓴다.

가중치를 바꾸면 버전을 올린다. 전처리(`effort-text-v1`)나 기반 모델이 바뀌면 다시 임베딩하고 다시 학습해야 한다. 가중치 파일이 기반 모델 sha256, 차원, 전처리 버전을 담고 있어 맞지 않으면 엔진이 불러오지 않는다.

## 한계 (`effort-v1`)

수치는 [report.md](report.md)에 있다.

- 학습 데이터에는 실제 코딩 에이전트 요청에 붙은 난이도 신호가 없다. 가장 가까운 것은 GitHub 이슈와 그 해결 패치 크기(SWE-rebench)다. 보지 않은 SWE-bench Verified에서 평균 수준 오차는 0.60으로 항상 medium(0.70)보다 낫지만 정확도는 50%에 못 미친다.
- 짧은 요청을 low로 보는 쪽으로 치우쳐 있다. 짧은 학습 문장 대부분이 low·medium 커밋 제목이기 때문이다. 이슈 제목을 짧은 요청으로 함께 학습해도 짧은 디버깅 요청(특히 한국어)이 low로 판정되는 경우가 남는다.
- 한국어·일본어 high·xhigh 판정은 언어 간 정렬에만 기댄다. 한국어·일본어 코딩 요청에 대한 검증 자료가 없어 이 부분은 미검증이다.
- 학습 입력은 요청만 있다. 실제 판정 입력의 계획, 도구 호출, 이전 턴이 판정에 주는 영향은 검증하지 않았다.
- CPU와 GPU 임베딩의 판정은 테스트 세트에서 약 95% 일치한다. 같은 요청도 장치에 따라 다른 수준이 나올 수 있다.
- 보류 기준은 학습 데이터와 같은 분포의 보정 세트에서 골랐다. 분포가 다른 실제 요청에서는 확률이 덜 믿을 만하므로 보류가 적게 일어난다.
