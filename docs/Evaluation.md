# 비교 실험: `corral exec`와 `corral eval`

스펙 §1.3은 "멀티에이전트가 단일 에이전트보다 항상 싸거나 정확하다"를 목표로 두지 않고, 비용·지연·품질을 **실제 비교 실험으로 따로 평가**하라고 한다. 이 문서는 그 실험 도구다(로드맵 Core-③).

## 한 번 실행: `corral exec`

```sh
corral exec examples/eval/single-agent.corral.json --input brief.txt --json
```

- Studio를 빌드하거나 띄우지 않는다. 같은 Coordinator·SQLite 기록을 쓴다.
- `--demo`는 시뮬레이션 에이전트, 없으면 실제 모델(로컬 로그인 필요).
- **사람의 결정을 대신하지 않는다(스펙 §12).** 승인·결정이 필요한 지점에 닿으면 기다리지 않고 Run을 취소하고 종료 코드 3으로 끝난다. 결정이 필요한 Corral은 Studio나 `corral run --watch`로 실행한다.
- 종료 코드: 0 성공, 1 실패·취소, 3 사람이 필요함.
- `--json`은 상태, 출력, 모델 호출 수, 확인된 출력 토큰, 미확인 토큰, 실행 수, 걸린 시간, 추론 강도 판정 분포를 낸다.

## 변형 비교: `corral eval`

```sh
corral eval examples/eval/suite.json --demo --out report.json
```

suite는 지시문 목록과 Corral 변형 목록이다. 모든 변형을 모든 지시문으로 한 번씩, 한 번에 하나씩 실행한다(작업 공간당 활성 Run 1개). 표는 성공·사람 필요·실패 수와 평균 모델 호출·출력 토큰·시간·실행 수를 보인다. JSON 보고서에는 Run별 결과와 출력 전문이 있다.

`examples/eval/`에는 단일 에이전트와, 사람 승인을 뺀 조사 팀 변형이 있다(승인이 있으면 headless로 끝까지 갈 수 없다).

## 하지 않는 것

- **답의 품질을 판정하지 않는다.** 표는 비용과 시간만 잰다. 품질 비교는 출력 전문을 사람이 읽거나, 별도의 채점 단계(후속)로 한다.
- 실제 모델 실행은 비용·사용량이 생긴다. 일반 CI는 `--demo`만 쓴다(AGENTS 4).

## 기록

- 2026-10-16 데모 suite(지시문 2 × 변형 2): single 평균 모델 호출 2, team 16 / 실행 1 대 9.
- 2026-10-16 실제 모델 1회(`exec`, single, "In two sentences, what is a database index?", OpenAI 구독 로그인): 성공, 모델 호출 3, 출력 토큰 122, 10.6 s. 실제 답을 받았다. 이는 경로 확인이며 품질·비용 비교 결과가 아니다.
