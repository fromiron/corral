# CR-003: Coordinator 승인 단계(admission hooks)와 추론 강도 판정 관찰 모드

- 변경 ID / 제안자 / 날짜: CR-003 / Bell(요청), Claude(초안) / 2026-10-15
- 상태: **승인** (Bell, 2026-10-15). D1–D4는 제안안으로 확정했다. §9 순서로 요구·테스트·backlog·ADR·스펙을 갱신한다(AGENTS 10).
- 연결 문서: [스펙](../../Corral-Spec-v0.1.md) §3.2·§8.1·§9·§10.2·§13, [구현 플랜 v0.1](../../Corral-Implementation-Plan-v0.1.md) §11, [기술 설계](../Technical-Design.md) §5·§7.3·§9.1·§15, [의존성과 출처](../Dependencies-and-Sources.md) §4

## 0. 요약

두 가지를 한 CR로 묶는다. ②가 ①의 첫 사용처이고, ①만으로는 바뀌는 동작이 없기 때문이다.

1. **① Admission hooks:** Coordinator 안에 흩어진 모델 요청·도구 승인 검사를 이름·버전·순서가 있는 **gate**와, commit 뒤에 실행되는 **observer**로 정리한다. 기본 gate 집합은 지금과 **같은 이벤트를 같은 순서로** 낸다. 공개 플러그인 API나 런타임 로딩이 아니다.
2. **② 추론 강도 판정, 관찰 전용:** 스펙 §13의 v0.2 `DecisionProvider`를 첫 질문 종류 `reasoning_effort`로 시작한다. 모델 요청마다 provider가 `low | medium | high | xhigh` 중 하나를 고르고 확률을 낸다. Corral은 이를 **기록만 하고 요청에 적용하지 않는다.** 요청 permit, 예산 예약, worker, Pi 요청은 바뀌지 않는다.

적용(`apply`)과 자동 라우팅, 비용 절감 주장은 이 CR의 범위가 아니다. 관찰 데이터로 평가한 뒤 별도 CR에서 다룬다(구현 플랜 v0.1 §11 "자동 라우팅의 비용 절감은 별도 평가 단계").

## 1. 기존 요구 ID와 문구

| 위치 | 기존 문구 | 이 CR과의 관계 |
|---|---|---|
| 스펙 §3.2 | MVP 제외: "자동 판단 라우팅, Local/Jev/Hybrid … A2A/MCP 확장 로딩" | Local/Jev 중 **관찰 전용 `reasoning_effort` 질문만** 범위에 넣는다. 자동 라우팅·Hybrid·확장 로딩은 계속 제외 |
| 스펙 §13 | "v0.2는 Local/Jev의 수동 교체 가능한 DecisionProvider를 구현한다. 질문 종류·후보·응답 검증이 같은 범위에서만 전환하고, 성능 우열이나 자동 절감은 별도 평가한다." | 이 문구를 그대로 따른다. 첫 질문 종류를 정한다 |
| 구현 플랜 v0.1 §11 | "DecisionQuestion, 후보 집합, response schema, capability registry, timeout, privacy policy를 먼저 명세한다. 해당 로컬 모델이 지원하지 않는 질문을 형식만 맞춰 전달하지 않는다." / 1차 수용 기준: "같은 질문·후보에 두 adapter를 연결하고 결과·지연·오류·근거 수준을 비교 가능한 형태로 기록" | §3·§4에서 여섯 항목을 모두 정의한다. 비교 기록은 §3.6 |
| 기술 설계 §15 | "`DecisionProvider`는 이번 단계에서 플러그인 시스템으로 만들지 않고 … 작은 내부 포트만 유지한다." | 포트는 계속 내부 포트다. 등록은 Coordinator 생성 시 정적으로만 한다 |
| 기술 설계 §5.1 | 원자적 경계: 검사와 commit 사이에 비동기 작업을 두지 않는다 | gate는 동기·순수 함수로 제한한다(§2.2) |
| 스펙 §8.2 / 기술 설계 §9.1 | 요청 스냅샷(ContextSnapshot)에 실제로 포함된 것만 인과로 연결 | 판정 입력은 commit된 스냅샷에서만 만든다. 판정은 요청 내용에 들어가지 않으므로 인과 연결 대상이 아니다 |
| 스펙 §10.2 | 키·사용자 본문을 로그·export에 노출하지 않는다 | 외부 provider로 보내는 입력의 범위와 기록 방식을 §3.5에서 정한다 |

## 2. 제안: ① Admission hooks

### 2.1 지금 코드의 승인 지점

`packages/core/src/coordinator.ts` 기준(2026-10-15, main `6959c4b`).

| 지점 | 지금 하는 일 | 결과 이벤트 |
|---|---|---|
| `prepareModelRequest` | 안전 경계 대기 → 활성 확인 → 무진전(6턴) 검사·사용자 승인 요청 → 모델 슬롯 획득 → `admitModelRequest` 예산 검사 → 대기 지시 수집 | `limit.reached` 또는 `budget.reserved`, `directive.attached`, `model.request_prepared`, `effect.admitted` 한 번에 commit |
| `authorizeTool` | 닫힌 질문에 대한 reply 확인 → 경계 대기 → `toolRefusal`(역할 허용 목록·한도) | `tool.requested` + `tool.allowed`(policyVersion `role-allowlist@1`) 또는 `tool.blocked`, 필요 시 `limit.reached` |
| `executeTool` | 1회 실행 확인 → `toolRefusal` 재검사 | `effect.admitted(kind: tool)`, `tool.started` … |

### 2.2 구조

- **Gate:** `{ id, version, stage, check(view) → allow | refuse(code, message, limit?) | require_approval(kind, limit) }`.
  - `stage`는 `model.admit`, `tool.authorize`, `tool.execute` 세 가지다.
  - `view`는 그 시점의 projection·limits·execution 입력·도구 제안을 **읽기 전용**으로 묶은 값이다. gate는 상태를 바꾸지 않고 I/O·시계·난수를 쓰지 않는다. 시간이 필요하면 주입된 clock 값을 view로 받는다.
  - 같은 stage의 gate는 등록 순서대로 실행하고, 첫 거절에서 멈춘다.
  - gate가 예외를 던지면 **거절(fail closed)** 한다. 코드는 `POLICY_ERROR`, 사유에는 gate id만 남긴다. 승인으로 처리하지 않는다.
- **Observer:** `{ id, version, on: 'model.prepared' | 'model.finished' | 'tool.finished', handle(frozenView, sink) }`.
  - commit **뒤에** 비동기로 실행되며 요청을 막거나 바꾸지 못한다.
  - 결과는 `sink`를 통해서만 남긴다. `sink`는 Coordinator가 run·execution·attempt·modelCallId로 fence를 확인한 뒤 정해진 이벤트로 commit한다(AGENTS 6).
  - observer 예외·지연은 Run에 영향을 주지 않는다.
- **Coordinator가 계속 소유하는 것:** 안전 경계 대기, 슬롯, 승인 요청 생성, ID 발급, commit. 이것들은 스케줄링이지 정책이 아니므로 gate로 옮기지 않는다.
- **등록:** `new Coordinator({ admission: { gates, observers } })`로 생성 시 한 번만 받는다. 기본값은 지금 동작을 재현하는 gate 집합이다: `no_progress@1`, `budget@1`, `question_open@1`, `role_allowlist@1`, `limits@1`. Run 도중 추가·제거하지 않는다. 사용자 정의 hook, 동적 로딩, 공개 API는 없다.
- **기록:** `tool.allowed.policyVersion`은 gate **집합**의 버전이다. 기본 집합은 지금 값 `role-allowlist@1`을 그대로 쓴다. 그래야 리팩터 전후 이벤트가 바이트 단위로 같다. 집합을 바꾸는 후속 CR이 새 값을 정한다. `model.admit` 단계는 지금처럼 별도 버전 필드를 두지 않는다.
- **순서 보존:** 지금 `authorizeTool`은 닫힌 질문에 대한 reply를 **안전 경계 대기 전에** 거절하고 `observation.late`를 남긴다. 이 검사는 `tool.authorize` stage 안에서도 경계 대기 앞에 두는 사전 gate(`pre_boundary`)로 유지한다. 위치가 바뀌면 golden 테스트가 실패해야 한다.

### 2.3 하지 않는 것

Cordis식 효과 스코프, 플러그인 패키지, MCP/도구 권한 확장(로드맵 ④는 별도 CR), gate 결과 캐시, Run 중 정책 교체.

## 3. 제안: ② `reasoning_effort` 판정(관찰 전용)

### 3.1 DecisionQuestion

```ts
type DecisionQuestion = {
  questionKind: 'reasoning_effort';
  questionVersion: 1;
  candidates: ['low', 'medium', 'high', 'xhigh'];   // 순서 = 강도 순서
  subject: { runId; executionId; attemptNo; modelCallId; contextSnapshotId };
  input: EffortInput;                                // §3.5
};
```

후보는 Pi의 `ThinkingLevel`(`off … max`, 7단계)이 아니라 **추상 4단계**다. 모델별 매핑(`getSupportedThinkingLevels`, `clampThinkingLevel`)은 적용 CR에서 정한다. `off`·`minimal`·`max`는 판정 후보에 넣지 않는다.

### 3.2 응답 schema와 검증

```ts
type DecisionAnswer = {
  answer: 'low' | 'medium' | 'high' | 'xhigh';
  probabilities: Record<Candidate, number> | null;  // 각 0..1, 합 1±0.01
  evidenceLevel: 'model_probability' | 'rule' | 'none';
  providerId: string; providerVersion: string;      // 예: local-heuristic@1
};
```

`answer`가 후보 밖이거나, 확률이 범위를 벗어나거나, 합이 맞지 않거나, 필드가 더 있으면 `decision.failed(reason: invalid_response)`로 남긴다. 조용히 고치거나 버리지 않는다.

### 3.3 Capability registry

provider는 `{ providerId, version, questionKinds: [{ kind, version }], privacy: 'local' | 'external', timeoutMs, available() }`를 선언한다. Coordinator는 **선언하지 않은 질문 종류·버전을 보내지 않는다.** Run 시작 시 설정된 provider가 질문을 선언하지 않았거나 쓸 수 없으면 Run은 그대로 시작한다. 판정만 꺼지고 그 사실을 `run.started`에 기록한다.

### 3.4 모드·전환·시점

- **모드:** `off | observe` 두 가지만 둔다. 기본값은 `off`다. `apply`는 이 CR에 없다.
- **수동 전환:** workspace 설정 `decisions.reasoning_effort = { mode, providers: [...] }`. provider는 1개 또는 2개다. 2개면 같은 요청에 두 판정을 모두 남긴다(구현 플랜 §11 1차 수용 기준). 설정은 **Run 시작 시 고정**한다. Run 도중 바꾸지 않는다(스펙 §8.3의 미래 패치 대상도 아니다).
- **시점:** `model.request_prepared` commit 직후 observer가 시작한다. 입력은 그 commit의 스냅샷에서만 만든다. permit 발급을 기다리게 하지 않는다.
- **늦은 결과:** 요청이 끝난 뒤 도착한 판정도 기록한다. `readyBeforeDispatch`(판정 완료가 해당 요청의 `request_dispatched` 전이었는지)를 함께 남긴다. 나중에 `apply`가 가능한지 판단할 근거다. Run이 종결된 뒤 도착한 결과는 commit하지 않는다.
- **pause·cancel:** pause 중에는 새 **외부** 판정 호출을 시작하지 않는다(외부 효과 admission 차단과 같다). execution 취소 시 진행 중 판정은 AbortSignal로 중단하고 `decision.failed(reason: cancelled)`를 남긴다(Run이 종결되기 전인 경우만).
- **한도:** Run당 판정 호출 상한 `maxDecisionCalls`(기본 = `maxModelCalls`, hard cap 100), provider별 timeout(기본 local 1,000ms, external 3,000ms). 판정 호출은 모델 호출·토큰 예산에 포함하지 않는다. 상한에 닿으면 `limit.reached(decision_calls)`를 남기고 그 Run의 판정만 멈춘다.

### 3.5 입력과 개인정보

- `EffortInput`은 Coordinator가 만든다(worker·adapter가 아니다): 역할의 outputContract, 배정 종류(scheduled/delegated/question), Loop 회차, 직전 검토 verdict, 입력 산출물 수와 총 길이, 이번 요청에 붙은 지시 수, 직전 도구 이름 목록. 그리고 **본문 발췌**: brief·배정 brief·질문 본문·이번 요청 지시 본문을 합쳐 UTF-8 1,500자까지.
- 이벤트에는 발췌 **본문을 저장하지 않는다.** `inputHash`(정규화 JSON의 SHA-256)와 본문 외 특징 값만 남긴다. 본문은 이미 로컬 private 기록(기술 설계 §9.1)에 있다.
- **외부 provider(`privacy: external`)**: live 모드 Run에서만, workspace 설정의 명시적 opt-in이 있을 때만 쓴다. mock Run·공개 데모·CI에서는 시작 시 거절한다. 전송 전 `effect.admitted(kind: decision)`를 commit해 "외부로 보냈다"는 사실을 먼저 남긴다. 자격 증명·로컬 경로·artifact 원문 전체는 보내지 않는다.

### 3.6 Provider (이 CR에서 만드는 것)

| provider | privacy | 내용 | 비고 |
|---|---|---|---|
| `scripted@1` | local | 테스트·데모용 결정적 응답 | testkit |
| `local-heuristic@1` | local | §3.5 특징 값의 문서화된 규칙. 확률 없음(`evidenceLevel: rule`) | 새 의존성 없음. **정확도를 주장하지 않는 기준선** |
| `local-model` | local | 임베딩 분류기(ONNX) | **결정 D1**. 기본안은 후속 CR |
| `jev` | external | Jev decision API adapter | **결정 D2**. API 계약 미확인 |

비교 기록: 같은 `modelCallId`·`inputHash`에 provider별 `decision.observed`가 하나씩 생긴다. `corral inspect <run-id>`가 판정을 요청별로 나란히 보여준다(answer, 확률, latencyMs, 실패 사유, readyBeforeDispatch).

### 3.7 화면

- Run 화면의 Budget 탭 "Usage by request"와 Activity 탭에 요청별로 **"Effort judgment (observe only, not applied): high · local-heuristic@1"**을 보인다. "not applied"를 생략하지 않는다.
- 실패·timeout·후보 밖 응답도 같은 자리에 같은 무게로 보인다(스펙 §4.4).
- 공개 데모는 `local-heuristic@1`을 worker 안에서 observe로 켠다. 외부 호출은 없다.

## 4. 이유

- 로컬 임베딩 분류기로 요청별 추론 강도를 고르는 방식이 공개 사례에서 출력 토큰을 줄였다는 보고가 있다(mixdog `docs/auto-reasoning-effort.md`, 2026-10-15 열람: EmbeddingGemma 기반 4단계 분류, `off | observe | on` 모드, 과소 판정을 더 비싸게 보는 기대 비용 선택, prompt cache를 깨지 않는 경우에만 적용). **이 수치는 Corral에서 검증하지 않았다.**
- Corral의 차별점은 자동화 자체가 아니라 "누가 언제 무엇을 바꿨는지"를 보이는 것이다. 판정을 먼저 관찰 기록으로 남기면 적용 전에 실제 Run 데이터로 정확도·지연·준비 시점을 평가할 수 있다. 이는 스펙 §13의 "성능 우열이나 자동 절감은 별도 평가" 순서와 같다.
- gate/observer 분리는 이후 도구 권한(MCP 등)·판정 적용이 붙을 자리를 만들고, 3,849줄짜리 `coordinator.ts`의 승인 로직을 테스트 가능한 단위로 나눈다.

## 5. 기존 합의와 충돌하는 부분

- **스펙 §3.2의 "Local/Jev" 제외:** 관찰 전용 `reasoning_effort`만 범위로 옮긴다. 문구를 "Local/Jev의 판정 **적용**·자동 판단 라우팅·Hybrid"로 바꾸는 것을 제안한다.
- **스펙 §9 한도 표:** `maxDecisionCalls`와 판정 timeout 두 행이 늘어난다.
- **스펙 §10.2:** 외부 decision provider 전송 규칙(§3.5)을 추가한다.
- **기술 설계 §15 "플러그인 시스템으로 만들지 않고":** 유지한다. gate·observer·provider는 생성 시 정적 등록이다.
- 위 외의 Reins·예산·인과 규칙은 바꾸지 않는다. 특히 판정은 `RequestPermit`·`maxOutputTokens`·예약량을 바꾸지 않는다.

## 6. 이벤트·저장 schema 영향

| 항목 | 변경 |
|---|---|
| 새 이벤트 | `decision.requested`(subject, questionKind/Version, providerId@version, privacy, inputHash), `decision.observed`(위 + answer, probabilities, evidenceLevel, latencyMs, readyBeforeDispatch, afterRequestFinished), `decision.failed`(위 + reason: `timeout | invalid_response | provider_error | unavailable | cancelled`) |
| `effect.admitted.kind` | `'decision'` 추가(외부 provider만) |
| `limit.reached.limitKind` | `'decision_calls'` 추가 |
| `run.started` | `decisions: { reasoning_effort: { mode, providers: [{ id, version, privacy, available }] } }` 추가. 판정이 꺼진 경우도 기록 |
| projection | `decisions: Record<decisionId, DecisionView>`, 요청별 인덱스 |
| SQLite | 이벤트 테이블은 그대로. 새 migration은 projection 캐시 테이블이 생길 때만(없으면 불필요) |
| workspace 설정 | `decisions` 키 추가. 알 수 없는 키는 지금처럼 거절(C-062) |
| export | `--redact`는 inputHash·특징 값을 유지한다. 본문 발췌는 원래 이벤트에 없다 |
| 계약 생성물 | `contracts/event-catalog.json`, JSON Schema, Zod 3자 parity(`contracts:check`) |

기존 이벤트의 의미·순서는 바꾸지 않는다. `mode: off`인 Run의 이벤트 열은 `run.started`의 새 필드를 빼면 지금과 같아야 한다.

## 7. 테스트: 바꿀 것과 지켜야 할 반례

새 요구 ID: `CRL-RUN-008` admission gate·observer(순서, fail closed, 기본 집합의 이벤트 불변), `CRL-DEC-001` 판정 계약·검증, `CRL-DEC-002` 관찰 전용(요청 불변), `CRL-DEC-003` 외부 provider 개인정보·opt-in, `CRL-DEC-004` 비교 기록과 표시. 각 요구에 `-H`/`-N` 시나리오를 만든다. (초안의 "CRL-DEV-002에 연결"은 승인 시 별도 요구 `CRL-RUN-008`로 바꿨다. DEV-002는 주입 규칙이고 gate 규칙과 범위가 다르다.)

**리팩터 증명(①)**
- 기존 unit/contract/integration/E2E 전체가 **수정 없이** 통과한다. 수정이 필요하면 리팩터가 동작을 바꾼 것으로 본다.
- 같은 seed의 기존 시나리오에서 이벤트 열이 리팩터 전 golden과 바이트 단위로 같다. golden은 ①을 시작하기 전에 고정하고, ①만 들어간 시점에 비교한다. ② 이후에는 `run.started.decisions` 필드 하나만 다를 수 있으며, 그 필드를 뺀 비교를 유지한다.
- 반례: gate 예외 → `POLICY_ERROR` 거절, 아무것도 admit되지 않음. gate가 view를 바꾸려 하면 실패(frozen view). 거절한 gate 뒤의 gate는 실행되지 않음. observer 예외는 Run 상태를 바꾸지 않음.

**관찰 전용(②)**
- off와 observe에서 같은 seed의 `RequestPermit`(maxOutputTokens, directives)과 `budget.reserved`가 같다.
- 선언하지 않은 질문 종류를 provider에 보내지 않는다(호출 0회).
- 후보 밖 answer, 확률 합 오류, 추가 필드 → `decision.failed(invalid_response)`.
- timeout → `decision.failed(timeout)`, 요청 이벤트 순서는 off와 같다.
- 같은 요청에 provider가 두 번 응답 → 이벤트 1건(decisionId 멱등).
- 요청 종료 뒤 결과 → `afterRequestFinished: true`로 기록. Run 종결 뒤 결과 → commit 없음.
- pause 중 외부 판정 시작 없음. execution 취소 → 진행 중 판정 abort, `cancelled` 기록.
- `maxDecisionCalls` 도달 → `limit.reached(decision_calls)`, 모델 요청은 계속됨.
- 외부 provider가 mock Run·데모·CI 설정에 있으면 시작 시 거절. 이벤트·로그·export에 본문 발췌·자격 증명·로컬 경로가 없다(TC-SEC-002 확장).
- provider 2개 → 같은 inputHash로 2건. UI는 두 판정을 모두 보이고 "not applied"를 표시한다(Storybook axe 포함).

유지할 반례: 지시는 실제로 포함된 요청부터만 인과 연결(TC-RNS-010), unknown usage를 0으로 표시하지 않음(TC-OBS-004-N), 늦은 결과로 Task/Run을 되살리지 않음(TC-DEV-001).

일반 CI에는 `scripted`·`local-heuristic`만 쓴다. Jev live 검증은 opt-in이며 호출 상한을 둔다(AGENTS 4).

## 8. 일정·보안·호환성 영향

| 작업 | 추정 |
|---|---:|
| 리팩터 전 golden 이벤트 열 고정, gate/observer 포트, 기존 검사 이전 | 10–16h |
| DecisionQuestion·검증·registry·이벤트·projection·계약 생성물 | 8–12h |
| `scripted@1`, `local-heuristic@1`, workspace 설정 | 4–6h |
| Run 화면·`corral inspect` 표시 | 4–6h |
| 문서(스펙·기술 설계·ADR 2건·API 계약) | 3–4h |
| **합계(D1·D2 기본안 기준)** | **29–44h** |

- **보안:** 외부 판정은 새 데이터 유출 경로다. 기본 off, live 전용 opt-in, 전송 전 effect 기록으로 다룬다.
- **호환성:** 새 이벤트·필드만 추가한다. 이전 버전 reader는 새 이벤트를 모른다. 새 Run을 이전 버전으로 여는 경우는 지원하지 않는다(지금도 schemaVersion 0.1 단일).
- **성능:** observer는 commit 뒤 비동기라 요청 지연에 들어가지 않는다. `local-heuristic`은 동기 계산 수준이다. 성능 시험(TC-UX-002)을 observe 켠 상태로 한 번 더 돌린다.
- **의존성:** D1 기본안에는 새 의존성이 없다.

## 9. 승인 후 순서

1. 이 CR 승인 → `contracts/requirements.json`, `tests/test-catalog.json`(새 시나리오는 `planned`), `tests/traceability.json`, `contracts/backlog.json`(태스크 C-067~)에 등록.
2. ADR-024 "Admission은 정적 등록 gate(동기·fail closed)와 commit 뒤 observer로 나눈다", ADR-025 "DecisionProvider는 관찰 전용으로 시작하고 Run 시작 시 고정한다" 작성.
3. 스펙 §3.2·§9·§10.2·§13, 기술 설계 §5·§15, API 계약 갱신.
4. 리팩터 golden 테스트 작성 → 실패하는 새 테스트 확인 → ① 구현 → ② 구현.

## 10. 결정 필요

| ID | 질문 | 선택지 | 제안 |
|---|---|---|---|
| D1 | 로컬 판정기를 무엇으로 시작하나 | (a) `local-heuristic@1`만, 모델은 후속 CR / (b) 처음부터 ONNX 임베딩 분류기 | **(a)**. (b)는 onnxruntime-node 등 새 의존성의 버전·라이선스·Node 호환 기록과 가중치 출처 확인이 필요하다(AGENTS 8). mixdog 판정 모델 가중치의 재사용 허용 여부는 확인하지 않았다 |
| D2 | Jev adapter를 이 CR에 넣나 | (a) 계약만 맞추고 spike는 별도 / (b) 이 CR에 포함 | **(a)**. Jev API 형식·인증·요금을 확인하지 않았다. 1차 수용 기준의 "두 adapter 비교"는 `scripted`·`local-heuristic`으로 계약을 먼저 증명하고, Jev spike에서 실제 비교를 한다 |
| D3 | 후보 단계 | (a) 추상 4단계 / (b) Pi 7단계 그대로 | **(a)**. 모델마다 지원 단계가 달라 Pi 단계를 그대로 쓰면 판정이 모델에 묶인다 |
| D4 | 판정 입력 본문 저장 | (a) hash와 특징 값만 / (b) 발췌 본문도 이벤트에 | **(a)**. 본문은 이미 private 기록에 있고 export 노출 위험만 늘어난다 |

## 11. 확인한 것과 확인하지 않은 것

- **확인함(타입 선언·코드 열람):** pi-agent-core 1.2.0의 `prepareRequest`가 다음 요청의 `thinkingLevel`을 돌려줄 수 있고, pi-ai 1.2.0에 `getSupportedThinkingLevels`·`clampThinkingLevel`이 있다. Corral worker(`packages/adapter-pi/src/worker.ts`)는 지금 `thinkingLevel`을 설정하지 않는다. 관찰 모드는 worker를 바꾸지 않는다.
- **확인하지 않음:** 실제 provider에서 요청 중간 강도 변경이 prompt cache를 깨는지, Jev API, mixdog 수치의 Corral 재현. 적용 CR 전에 각각 spike로 확인한다.

## 12. 승인 / 보류 / 반려와 근거

승인(Bell, 2026-10-15): "Approve CR-003 with D1–D4 as proposed." D1 `local-heuristic@1`부터, D2 Jev는 계약만 맞추고 별도 spike, D3 추상 4단계, D4 hash와 특징 값만 저장.

반영: [ADR-024](../Decisions.md), [ADR-025](../Decisions.md), 요구 `CRL-RUN-008`·`CRL-DEC-001`~`004`, 태스크 C-067~C-071.

## 13. 진행 기록

- 2026-10-15: §9의 1–3단계 완료(요구·시나리오·태스크·traceability, ADR-024·025, 스펙·기술 설계·API 계약).
- 2026-10-15: C-067 시작. 리팩터 **전** Coordinator로 golden 이벤트 열 10개(898 events)를 `packages/core/test/golden/`에 고정했다(`admission-golden.test.ts`, `[TC-RUN-008-H]`). 시나리오는 모든 승인 지점을 지난다: 예산(`model_calls`), 무진전 승인, 역할 허용 목록(`CAPABILITY_DENIED`), spawn 한도, 닫힌 질문 reply(`observation.late`), 지시 전달, 취소, 검토 Loop와 승인 2회, 협업. 각 시나리오는 두 번 실행해 결정적인지 먼저 확인한다. 민감도 확인: `TOOL_POLICY_VERSION`을 `@2`로 바꾸면 `tool.allowed`가 있는 6개가 실패하고, 무진전 기준을 7로 바꾸면 해당 시나리오가 실패했다(되돌림 확인). core는 런타임 중립(ADR-014)이라 파일은 Vite raw import로 읽고 Vitest file snapshot으로 기록한다. 재기록은 `CORRAL_UPDATE_GOLDEN=1 … -u`로만 한다.
- 2026-10-15: C-067 구현. `packages/core/src/admission/`에 gate·observer·기본 gate를 두고 Coordinator의 세 승인 지점을 옮겼다. 새 테스트 `admission-gates.test.ts`(`[TC-RUN-008-H]` 3, `[TC-RUN-008-N]` 5)를 구현 전에 실행해 8개 모두 실패를 확인했다. 구현 후 golden 10개가 바이트 단위로 같고, 기존 테스트 파일은 하나도 바꾸지 않았다.
  - **승인 시 문서와 달라진 점:** (1) 무진전 검사는 모델 슬롯을 잡기 전, 예산 검사는 잡은 뒤라서 `model.admit` 하나가 아니라 `model.request`·`model.admit` 두 stage다. (2) 닫힌 질문 검사는 `tool.pre_boundary` stage다. (3) `POLICY_ERROR`는 기존 `ErrorCode`에 없어서 contracts enum, 생성 JSON Schema, 서버 HTTP 매핑(500), API 계약 오류 표에 추가했다. §6 schema 표에서 빠져 있던 항목이다. (4) observer는 아직 결과를 기록하는 sink가 없다. decision 이벤트가 생기는 C-068에서 fence 확인 sink를 붙인다.
  - **구현 중 발견:** 처음 만든 읽기 전용 proxy가 frozen 이벤트와 공유된 도구 인자에서 Proxy 불변식 위반으로 예외를 냈고, fail closed 설계대로 `POLICY_ERROR` 거절이 되어 golden 3개가 실패했다. shadow target 방식으로 고쳤다. golden이 리팩터 회귀를 실제로 잡은 사례다.
- 2026-10-16: **D1 변경(Bell)** — mixdog effort judge 모델(EmbeddingGemma 2 파생, Apache-2.0; 학습 데이터 출처 고지 포함)을 그대로 써도 된다. `local-model` provider를 C-072로 추가한다. `local-heuristic@1`은 의존성 없는 기준선으로 유지한다.
- 2026-10-16: C-068·C-069 구현. contracts에 `DecisionAnswer`·`EffortFeatures`·`RunDecisionSettings`·`decision.*` 이벤트·ID kind `decision`·`DecisionProvider` 포트. core에 `decisions/`(설정 고정, 질문 생성, observer hub)와 `LocalHeuristicProvider`, projection의 `decisionSettings`·`decisions`. observer에 Coordinator가 fence하는 context(record·onCancel·timers)를 붙였다. workspace 설정 `decisions.reasoning_effort`. 테스트 16개(`[TC-DEC-001-H/N]`, `[TC-DEC-002-H/N]`)를 구현 전에 실패로 확인. 판정이 없는 Run의 golden은 그대로 통과.
  - **승인 문서와 달라진 점:** observe와 off의 비교는 `runSeq`·`eventId`를 뺀 내용으로 한다. 판정 이벤트가 순번을 차지하므로 순번은 같을 수 없다. 서버는 판정 설정을 항상 `run.started`에 기록하고(기본 `off`), 브라우저 런타임은 설정이 없으면 필드를 생략한다.

