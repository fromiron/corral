# 참조 추론 판정기와 Corral 비교

사용자가 제공한 추론 정책·워커 코드와 ONNX 파일을 읽고, 기존 임베딩과 `effort-v2` 가중치를 유지한 채 장점을 적용했다. 외부 모델 파일과 토크나이저는 저장소에 포함하지 않는다.

| 항목 | 참조 구현 | Corral의 적용 |
|---|---|---|
| 분포를 고려한 판정 | 수준 차이와 심한 과소 판정의 비대칭 기대비용 최소화 | 불확실한 low만 재검토한다. high/xhigh는 argmax를 유지해 매우 어려운 요청의 판정을 낮추지 않는다. |
| 요청별 기준 | 매 요청을 설정된 기준에서 시작 | 요청마다 독립적으로 판정하는 기존 동작을 유지한다. 이전 요청의 추론 수준을 누적하지 않는다. |
| 지원 수준 | 모델의 지원 사다리에 제한, 최상위 수동 수준 제외 | 지원 low–xhigh로 매핑하며 off/minimal/max를 자동 선택하지 않는 기존 경계를 유지한다. |
| 입력 형식 | 학습 당시의 rp/rpq/rpc/pack 및 도구 단계 형식 | 현재 head의 effort-text-v1과 모델 SHA 검증을 유지한다. 다른 모델의 전처리만 바꾸어 적용하지 않는다. |
| 확률 보정 | 모델 전용 temperature | 현재 head의 검증 분할로 보정한 값을 유지한다. 참조의 1.55는 참조 ONNX 비교에만 사용한다. |
| 상주·준비 | 상주 worker와 ready 전 실제 forward pass | 기존 공유 상주 엔진을 유지하고, provider warmUp이 고정된 비민감 입력의 실제 임베딩까지 완료하게 한다. |
| CPU 병렬도 | 해당 환경 부하 실험으로 4 threads | 다른 머신의 결과를 일반화하지 않는다. 현재 CPU 스레드 정책을 유지한다. |

## 판정 정책

[policy-comparison.md](policy-comparison.md)와 동명 JSON이 재현 가능한 고정 평가다. 같은 확률에서 기존 코딩 테스트의 high/xhigh→low는 17건에서 5건으로 감소하고 수준 일치율은 45.0%에서 45.1%다. xhigh 재현율은 51.2%로 유지한다. 전체 기대비용 규칙을 그대로 적용하면 xhigh 재현율이 35.3%로 낮아져 제한된 low 보호를 선택했다. 확률 상한 0.6은 테스트가 아닌 검증 분할의 정확도 비퇴행과 심한 과소 판정 감소로 선택했다.

보류는 기존 외부 판정 opt-in, 공유 3초 제한, 취소, effect 기록 경로를 사용한다. 외부 판정이 없으면 medium이다. 정책 버전은 `corral-effort-v2`이며 과거 정책 기록은 그대로 읽는다.

```sh
node tools/local-intelligence/effort/compare-policy.ts <original-samples.jsonl> <original-cpu.f32> packages/local-intelligence/weights/effort-v2.json <out-base>
```

## 사전 준비 실측

[warmup-comparison.json](warmup-comparison.json)은 CPU에서 두 방식을 번갈아 실행한 6회 소규모 측정이다. 엔진 생성만 준비한 경우 첫 판정 중앙값은 59.8 ms, 실제 임베딩까지 준비한 경우는 50.6 ms였다. 준비 시간 중앙값은 각각 139.1 ms와 192.4 ms다. 일부 비용을 첫 요청 이전으로 옮긴 것이며 전체 시작 시간이 줄었다는 뜻이 아니다. 동시 에이전트 부하나 GPU에 대한 성능 보장은 아니다.

## 제공 ONNX 확인

- 파일 SHA256: `d01ceb1685e123335d2b70809e7b53fcc07ffb110b9412b408bc6b09a5394288`.
- 입력: int64 `input_ids`, `attention_mask`; 출력: float `[batch, 4]` logits. 외부 tensor 파일은 없고, 4-bit `MatMulNBits` 연산과 `[4, 768]` 분류 head가 있다. 학습 그래프는 포함되지 않는다.
- CPU ONNX Runtime 1.23.2에서 실제 추론을 확인했다. 제공 코드의 rp 형식, BOS=2/EOS=1, 최대 256 tokens, temperature=1.55를 사용했고 xhigh bias를 별도로 중복 적용하지 않았다. 토크나이저 JSON은 Tokenizers 0.22.1로 읽었다.
- 같은 공개 검증 2,545건의 argmax 라벨 일치율은 Corral 53.0%, 참조 ONNX 38.4%였다. 코딩 검증 1,579건은 각각 45.6%, 35.6%다. 참조의 기대비용 정책까지 적용한 값은 전체 39.8%, 코딩 37.0%다.
- 정책 비교는 기준 medium과 low/medium/high/xhigh를 모두 지원하는 사다리를 가정한다. 참조 앱의 실제 사용자 기준 설정이나 공급자별 효과를 측정한 것은 아니다.
- 반면 작성한 일반 코딩 요청 검증 24건에서는 Corral argmax 58.3%, 참조 ONNX argmax 75.0%였고 참조 정책 적용 후는 62.5%였다. 공개 패치 크기 기반 대리 라벨과 실제 요청의 의미가 다르므로 이 결과만으로 두 모델의 실사용 우열을 단정하지 않는다.
- 원래 학습·평가 자료의 중복 여부는 알 수 없다. `compact-tokenizer.mjs`와 `judge-input.mjs`가 없어 사용자 구현과의 전체 토큰 일치 및 도구 단계 입력은 검증하지 않았다. 위 비교는 요청 문장 경로만 다룬다.

ONNX는 교사 모델로 추론해 학습용 soft label을 만드는 데 활용할 수 있다. 다만 4-bit 추론 그래프를 그대로 추가 학습하려면 지원되는 학습 그래프·체크포인트·최적화 설정이 필요하다([ONNX Runtime 학습 문서](https://onnxruntime.ai/docs/api/c/training_c_cpp_api.html)). 미세조정된 backbone의 분류 head를 원래 backbone에 복사해도 같은 벡터 의미가 보장되지는 않는다. 현재의 공유 임베딩을 유지하려면 분류 head를 무조건 복사하는 대신 교사 출력의 품질을 검증한 뒤 학습 분할에서 증류하는 접근이 맞다. 난이도 4개 출력은 회의 응답자 선택의 정답을 제공하지 않는다.
