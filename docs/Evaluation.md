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

## 고정 정답 조건과 하네스 비교

각 brief에 `expected`를 넣으면 실행 상태와 별도로 채점한다. `phase`는 `calibration` 또는 `holdout`이며 생략하면 holdout이다. 두 단계는 합산하지 않는다.

```json
{
  "id": "add",
  "brief": "Return the JSON object {\"answer\":4} and no other text.",
  "phase": "holdout",
  "expected": { "kind": "json", "value": { "answer": 4 } }
}
```

지원 조건은 `exact` + `text`, `includes` + 비어 있지 않은 문자열 배열 `all`, `json` + JSON `value`다. 임의 코드나 모델을 채점기로 실행하지 않는다. `expected`가 없으면 품질 값은 미측정(null)이다.

- 최종 정답률: 고정 정답이 있는 전체 실행 중 정확한 최종 결과를 전달한 비율. 결과를 전달하지 못한 실행도 분모에 남는다.
- 잘못된 통과: 실행이 성공했지만 최종 답이 고정 정답 조건을 어겼다.
- 불필요한 반려: 후보는 정답이지만 검토 규칙의 품질 판정 뒤 시도/수정/무진전 한도에서 중단됐다. 승인 대기·검사 오류·취소·예산/시간 부족은 품질 반려로 세지 않는다.
- 재시도는 SDK 모델 요청 retry, execution 재시작, Loop 수정 회차를 따로 기록한다. 사용자 개입 요청 수도 별도다. 이벤트 이력을 끝까지 확인하지 못한 계측은 null/불완전으로 남긴다.
- 보고서에 Run ID, definition hash, 하네스·recipe hash, 실제 실행 시작된 도구 이름을 남긴다. 입력 설정 재현의 근거이며 LLM 출력 재현 보장은 아니다.

suite에 `comparison: "personal_harness"`를 지정하면 정확히 다섯 variant가 필요하다. 각 variant의 `group`은 `baseline`, `mandatory_skill`, `deterministic_check`, `review_repair`, `coding_tool` 중 하나이며 중복할 수 없다. 각 변형은 실제 저장된 하네스 revision을 참조하는 Corral 파일을 준비한다. 그룹 이름은 실험 조건의 선언이며 기능 사용/효과의 증거가 아니다. 보고서의 실제 적용 hash와 도구 기록도 함께 확인한다.

같은 과제·모델·부모 예산으로 비교하고 기준을 조정한 calibration 과제를 holdout으로 재사용하지 않는다. 파일 변경을 비교할 때는 각 실행의 초기 작업 사본도 같아야 한다. 승인·신뢰는 Studio에서 미리 검토하며 headless 실행이 대신 승인하지 않는다.

파일 도구 비교에서는 suite에 `workspace: { "projectId": "default", "baseCommit": "전체 Git commit hash" }`를 넣는다. 이미 연결하고 신뢰한 프로젝트에서 각 과제 × 변형마다 새 세션/작업 사본을 만든다. 지정 커밋이 로컬에 없으면 실패하며 HEAD로 대체하지 않는다. 결과의 `workspace`에는 세션과 실제 기준 커밋이 남는다. 비교 뒤 작업 사본은 검토를 위해 보존하며 Studio에서 정리할 수 있다. 원본 폴더의 미커밋 변경은 비교 초기 상태에 포함되지 않는다.

실제 모델 실행은 비용·사용량이 생긴다. 일반 CI는 시뮬레이션 또는 명시적인 로컬 fake provider만 쓴다(AGENTS 4). 결정적 테스트의 정답률은 계측/기능 검증이며 실제 모델의 품질 개선 수치가 아니다.

## 기록

H4 편집 도구 비교는 [fixture 실행 안내](../tools/evaluation/README.md)를 따른다. `corral eval examples/eval/coding-tools.json --hashline-binary <fixture-driver>`가 현재 전체 쓰기·Pi edit·원본 Hashline을 동일 broker 조건에서 비교한다. 이 실험은 위의 LLM 대조군 평가와 별도다.

- 2026-10-16 데모 suite(지시문 2 × 변형 2): single 평균 모델 호출 2, team 16 / 실행 1 대 9.
- 2026-10-16 실제 모델 1회(`exec`, single, "In two sentences, what is a database index?", OpenAI 구독 로그인): 성공, 모델 호출 3, 출력 토큰 122, 10.6 s. 실제 답을 받았다. 이는 경로 확인이며 품질·비용 비교 결과가 아니다.
