# effort 학습 데이터 출처

[fetch.py](fetch.py)가 아래 고정 리비전에서만 표본을 만든다. 가중치를 배포할 수 있는 허용형 라이선스만 학습에 쓴다. share-alike, 비상업, 변경 금지 라이선스나 라이선스가 불분명한 데이터는 학습에 넣지 않는다. 받은 원본과 표본은 저장소에 넣지 않는다.

| 출처 | Hugging Face 저장소 @ 리비전 | 라이선스 | 쓰는 파일과 필드 | 학습 표본 |
|---|---|---|---|---:|
| MATH | `EleutherAI/hendrycks_math` @ `21a5633873b6a120296cce3e2df9d5550074f4a3` | MIT | 7개 과목의 train·test parquet, `problem`, `level` | 3,200 |
| GSM8K | `openai/gsm8k` @ `740312add88f781978c0658806c59bc2815b9866` | MIT | `main` train·test parquet, `question` | 500 |
| MMLU | `cais/mmlu` @ `c30699e8356da336a370243923dbaf21066bb9fe` | MIT | `all/test` parquet, `question`, `subject`, `choices` | 800 |
| MMMLU | `openai/MMMLU` @ `325a01dc3e173cac1578df94120499aaca2e2504` | MIT | `test/mmlu_KO-KR.csv`, `test/mmlu_JA-JP.csv` | 1,600 (ko 800, ja 800) |
| TACO | `BAAI/TACO` @ `d593ed0a2becbbc952230bb89be09189bf1056dc` | Apache-2.0 (일부 내용 MIT, CC BY 4.0) | `ALL/*.parquet`의 `question`, `difficulty`, `source` 열만 범위 요청으로 읽음 | 2,700 |
| CommitPackFT | `bigcode/commitpackft` @ `fc56fe33c030c6daa414c2b112c932b8eed085e6` | MIT (허용형 라이선스 저장소의 커밋만 수록) | python, javascript, typescript, java, go, rust의 `data.jsonl`, `subject`, `old_contents`, `new_contents`, `repos` | 1,799 |
| SWE-rebench | `nebius/SWE-rebench` @ `89cdfbab4ab1bd8f5a658bb212d1b63624f4f881` | CC BY 4.0 | `data/filtered-*`, `data/test-*` parquet의 `instance_id`, `repo`, `problem_statement`, `patch` 열만 범위 요청으로 읽음 | 2,692 (같은 이슈의 제목만 2,332) |
| SWE-bench Verified | `SWE-bench/SWE-bench_Verified` @ `78f471bf655a3137b2e8a75af1501690ec009ec3` | 데이터셋 카드에 표기 없음 | test parquet, `problem_statement`, `difficulty`, `repo`, `instance_id` | 평가 전용 500 |

## 제외한 것

- TACO의 HackerRank 문제: TACO가 라이선스를 모른다고 밝혔다.
- SWE-bench Verified: 라이선스 표기가 없어 학습에 쓰지 않고 리포트의 평가에만 쓴다.
- APPS(`codeparrot/apps`): TACO가 APPS 문제를 이미 포함한다.
- KMMLU, JMMLU, MGSM, oasst2 같은 한국어·일본어 후보: 라이선스(변경 금지, 비상업, share-alike)가 맞지 않거나 난이도 신호가 없다.

## 고지

학습한 가중치(`packages/local-intelligence/weights/effort-v1.json`)는 위 데이터셋에서 유도했다. 저작자 표시는 `packages/local-intelligence/NOTICE.md`에 있다.
