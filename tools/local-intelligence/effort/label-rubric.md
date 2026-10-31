# effort 라벨 기준표

라벨은 공개 데이터셋에 이미 있는 난이도 신호를 low / medium / high / xhigh에 대응시켜 만든다. 사람이나 유료 LLM이 새로 라벨을 붙이지 않고, 이전 Mixdog 판정 모델의 출력도 쓰지 않는다. 구현은 [fetch.py](fetch.py)이고, 출처와 리비전은 [datasets.md](datasets.md)에 있다.

각 수준은 "추론 모델이 그 요청을 맞게 처리하려면 얼마나 생각해야 하는가"를 뜻한다.

| 수준 | 뜻 |
|---|---|
| low | 바로 답하거나 한두 단계로 끝나는 요청 |
| medium | 몇 단계의 추론이나 작은 범위의 변경이 필요한 요청 |
| high | 여러 단계를 계획하고 검증해야 하는 요청 |
| xhigh | 깊은 탐색이나 긴 추론이 필요한 요청 |

## 신호 대응

| 출처 | 신호 | low | medium | high | xhigh |
|---|---|---|---|---|---|
| MATH | `level` | Level 1 | Level 2, 3 | Level 4 | Level 5 |
| GSM8K | 데이터셋 자체(초등 수준 서술형 문제) | 전체 | | | |
| MMLU, MMMLU(ko, ja) | 과목 이름 | `high_school_*`, `elementary_*` | `college_*` | | |
| TACO | `difficulty` | | EASY | MEDIUM, MEDIUM_HARD | HARD, VERY_HARD |
| CommitPackFT | 커밋 전후 파일의 바뀐 줄 수(삭제+추가) | 1–2줄 | 3–30줄 | | |
| SWE-rebench | 이슈를 해결한 패치의 크기(파일 수, 삭제+추가 줄 수) | | 1개 파일, 6줄 이하 | 나머지 | 3개 파일 초과 또는 20줄 초과 |
| SWE-bench Verified (평가 전용) | `difficulty` | | `<15 min fix` | `15 min - 1 hour` | `1-4 hours`, `>4 hours` |

- SWE-rebench의 기준선은 SWE-bench Verified에서 사람이 매긴 소요 시간별 패치 크기 중앙값(15분 미만 4줄, 15분–1시간 9줄, 1–4시간 36줄) 사이에 두었다. 그래서 SWE-bench Verified 평가는 문장 기준으로는 학습과 분리돼 있지만 기준선 선택과는 완전히 독립적이지 않다. 이슈 해결은 저장소 탐색이 필요하므로 SWE-rebench에는 low를 두지 않는다.
- MATH의 `Level ?`, TACO의 `UNKNOWN_DIFFICULTY`, MMLU의 다른 과목(`professional_*` 등), 30줄을 넘는 커밋은 쓰지 않는다. 신호가 수준을 가르지 못하기 때문이다. 큰 커밋은 이름 변경이나 생성 코드처럼 줄 수와 난이도가 따로 노는 경우가 많다.
- 요청 문장은 데이터의 문제 원문이다. 객관식은 문제 뒤에 `A.`–`D.` 선택지를 붙이고, 커밋은 제목 줄만, 이슈는 제목과 본문(`problem_statement`)을 쓴다. 판정 입력은 제품과 같은 `effortText`(요청만 있는 입력)로 만든다.
- MMLU 문항과 그 MMMLU 번역은 한 그룹이다. 같은 문제의 영어·한국어·일본어 문장이 학습과 검증에 나뉘어 들어가지 않는다.
- 커밋과 이슈는 저장소 단위로, 나머지는 정규화한 문제 원문 단위로 묶는다. SWE-bench Verified에 있는 저장소의 이슈는 학습에 쓰지 않는다. 같은 원문은 한 번만 쓴다.

## 알려진 치우침

- 출처마다 쓰는 수준 범위가 다르다(GSM8K는 low뿐, TACO와 SWE-rebench는 medium 이상). 분류기가 난이도 대신 출처의 문체를 배울 수 있으므로 리포트는 출처별 수치를 따로 낸다.
- 한국어·일본어 표본은 MMMLU뿐이어서 low와 medium만 있다. high·xhigh 판정은 다국어 임베딩의 언어 간 정렬에 기대며, 리포트의 번역 병렬 일관성은 그 대리 지표다.
- 학습 입력은 요청만 있다. 실제 판정 입력의 계획, 도구 호출, 이전 턴은 학습 표본에 없다.
