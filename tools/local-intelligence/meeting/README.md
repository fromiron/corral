# 회의 응답자 선택

같은 EmbeddingGemma 2 임베딩을 사용하되 코딩 난이도와 별도 가중치를 학습한다. 현재 메시지의 의도(주제 질문·후속 질문·전체 의견·관점 비교)와 참가자별 최근 확정 발언·선택적인 역할 설명의 관련성을 사용한다. 이름이나 모델 브랜드는 학습 특징이 아니다. 후속 질문은 실제로 발언한 참가자와 연결하며, 여러 관점을 비교하는 요청에는 복수 참가자를 선택할 수 있다.

`topics.tsv`와 `discussions.tsv`는 저장소에서 작성한 MIT 라이선스의 합성 자료다. 코딩 외에 일상, 취미, 행사·제품 아이디어, 방문자·배송·참여 감소의 원인 가설, 대안 비교를 포함한다. 실사용 대화나 사람 검수 자료가 아니다. 역할이 없는 참가자도 확정 발언으로 구분한다. 원본 대화를 자동 수집하거나 외부 API로 보내지 않는다.

356개 시나리오를 주제 가족 단위로 나눠 테스트 72개를 고정한다. 같은 시나리오의 번역은 같은 분할에 둔다. 일부 후속 질문·전체 의견 요청 표현은 가족 사이에 공통이어서 이 평가만으로 새로운 표현의 일반화를 주장할 수 없다. 일반적인 참가자 수와 길고 모호한 실사용 회의의 별도 검증도 필요하다.

선형 의도 분류기와 6개 상대 관련성 특징의 이진 분류기를 학습한다. 참가자 간 유사도 평균을 빼서 대화 주제 전체가 비슷하다는 이유로 모두를 관련자로 분류하는 편향을 줄인다. 분류기·선택 기준은 검증 가족의 맥락 유형별 집합 일치율로 선택한다. 테스트는 후보 선택에 사용하지 않는다.

```sh
python tools/local-intelligence/meeting/dataset.py <work>/meeting-cases.jsonl
node tools/local-intelligence/meeting/embed.ts <work>/meeting-cases.jsonl <local-ai-dir> <work>/meeting-vectors.json
uv run --no-project tools/local-intelligence/meeting/train.py <work>/meeting-cases.jsonl <work>/meeting-vectors.json <work>/meeting-model
node tools/local-intelligence/meeting/compare.ts <work>/meeting-cases.jsonl <work>/meeting-vectors.json <work>/meeting-model/meeting-v1.json <work>/meeting-report
```

[검증 선택](validation.json), [고정 테스트 비교](report.md), [지표와 케이스별 결과](report.json). 기존에는 학습된 회의 선택기가 없었으므로 전체 참가자 응답과 학습 없는 유사도 1명 선택을 기준으로 비교한다. 기존 전체 응답의 집합 일치율은 새로 정의한 선택 과제에 대한 값이지, 이전 회의 기능의 성공률이 아니다.

모델을 고정한 뒤 `dataset.py <out> --phrasing-eval`로 학습에 없는 표현만 사용한 추가 36건을 만들었다. [별도 표현 평가](phrasing-eval.md)에서 집합 일치율은 77.8%이며, 전체 의견을 요청하는 새 표현은 33.3%에 그쳤다. 이 결과로 가중치나 임계값을 다시 맞추지 않았다. 명시적인 참가자 선택·@멘션은 학습 모델과 무관하게 우선하지만, 자연어 전체 호출의 표현 일반화는 아직 약하다.

제품 경계와 fallback은 [로컬 AI 명세](../../../docs/specs/features/local-intelligence.md#회의-분석)를 따른다. 전체 회의 중 최근 6개 메시지 묶음에서 최대 12개 확정 발언을 후보 맥락으로 사용하며, 참가자별 최근 발언과 역할은 각각 별도로 임베딩한다. 복잡한 과거 지시 대상 추적과 발언의 사실 검증을 수행하는 모델은 아니다.
