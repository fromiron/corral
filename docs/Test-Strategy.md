# Corral — SDD·TDD 검증 전략

## 1. 무엇을 테스트하는가

제품 기능은 아직 구현되지 않았다. 이 문서 패키지에 있는 test-catalog는 **구현해야 할 테스트 설계**다. 앱 테스트를 실행했다거나 통과했다는 보고가 아니다. 패키지 생성 시 수행하는 JSON·참조·ID 검사는 문서 일관성 검증이며 별도 Validation Report에 기록한다.

단위 테스트는 순수 decide/reduce, graph parser, budget allocator, version binding, scope matcher를 검증한다. contract 테스트는 JSON schema, Pi source event mapping, provider usage normalization, worker IPC, API receipt를 검증한다. 통합은 SQLite+Coordinator+mock effects, E2E는 브라우저에서 D&D와 Reins의 전체 흐름, live는 실제 provider 기능, performance는 고정된 부하 fixture를 사용한다.

## 2. 도구와 역할

| 도구 | 역할 | 주의 |
|---|---|---|
| Vitest | 단위·계약·통합, fake timers, coverage | timer advance 전에 microtask/외부 completion barrier를 명시 |
| React Testing Library | 접근 가능한 이름·사용자 행동 기반 DOM 검사 | 내부 store 구현에만 결합하지 않음 |
| Playwright | Canvas 좌표·포인터·키보드·브라우저 streaming | jsdom만으로 실제 SVG/viewport 행동을 증명하지 않음 |
| MSW | API 응답/오류·stream 상태 fixture | Coordinator 자체 논리는 mocked HTTP가 아닌 실제 통합으로 별도 검증 |
| fast-check | 명령 sequence와 경합 불변식·seed 재현 | 실제 LLM의 품질을 property로 판정하지 않음 |
| Storybook | 상태별 UI 계약·개입 패널·긴 문구 | 유료 서비스 없이 로컬 build+브라우저 테스트 |
| axe / Playwright | 자동 접근성 위반 탐지 | keyboard/IME/읽기 순서 수동 점검도 필수 |

## 3. 제어 가능한 Testkit

`FakeClock`은 wall/monotonic 시간을 각각 제공한다. `SequentialIdFactory`는 알려진 ID를 반환한다. `ScriptedAgentAdapter`는 요청 준비/응답 시작/도구 제안/답변/종료를 테스트가 결정하게 한다. `DeferredBarrier`로 “이 시점에 cancel이 들어옴”을 정확히 재현한다.

MockAdapter는 같은 roleId에 고정 문자열을 출력하는 것만으로 끝내지 않는다. 요청의 directiveIds, 실제 input version, graph 순서에 반응해야 D&D·스티어링 테스트가 의미 있다. Public DemoDriver는 같은 의미 계약을 사용하되 별도 worker/타이머로 시각적인 진행 시간을 제공한다.

네트워크 금지 테스트는 예상하지 않은 fetch를 실패로 처리한다. live suite만 명시적 key/env로 활성화한다. test log의 예산·usage는 fixture임을 표시한다.

## 4. 핵심 불변식

| ID | 불변식 |
|---|---|
| INV-01 | 같은 Task에 active attempt는 최대 하나 |
| INV-02 | 취소 fence 뒤 대상 scope에서 신규 effect admission 없음 |
| INV-03 | parent 완료/취소 시 required owned children은 모두 정리됨 |
| INV-04 | 동일 commandId+payload는 한 receipt/효과, 다른 payload는 충돌 |
| INV-05 | artifact version 본문/hash/원천은 불변 |
| INV-06 | review의 target와 criteria는 실제 검토한 snapshot과 일치 |
| INV-07 | directive 직접 적용은 해당 request snapshot 포함에서만 발생 |
| INV-08 | budget spent/reserved/unknown은 음수가 아니고 중복 정산되지 않음 |
| INV-09 | 모델 permit 수≤3, 기다리는 parent는 모델 permit을 점유하지 않음 |
| INV-10 | message-triggered spawn도 depth/total 제한을 사용 |
| INV-11 | terminal Run/Execution은 늦은 결과로 running/completed에 부활하지 않음 |
| INV-12 | layout 변경은 definitionHash를 바꾸지 않음 |
| INV-13 | rollback된 트랜잭션에서 provider/tool 효과가 발생하지 않음 |
| INV-14 | replay한 projection은 최종 DB projection과 동일 |
| INV-15 | provider raw usage 미확인을 0 비용으로 환산하지 않음 |
| INV-16 | 관측되지 않은 모델 내부 생각·행동을 UI가 생성해 표시하지 않음 |

## 5. 테스트 피라미드가 아니라 경계별 증거

모든 테스트를 E2E로 작성하지 않는다. `TC-RNS-001-N`은 Coordinator의 지시 큐/요청 snapshot을 통합으로 검증하고, 그 결과 receipt가 UI에 어떻게 보이는지는 별도의 Reins E2E로 검증한다. 화면 screenshot 하나가 예산 원자성을 보장하지 않으며, reducer test 하나가 실제 keyboard 조작을 증명하지 않는다.

Coverage 목표는 core/contracts line90/branch85로 시작한다. critical invariant에 음성·경합 테스트가 없다면 coverage를 넘겨도 release를 차단한다. PR에서는 안정된 mock suite, nightly/release에서는 seeded model-based와 성능 시험, live provider는 opt-in으로 실행한다.

## 6. 스티어링의 Given/When/Then

```gherkin
@CRL-RNS-001 @CRL-RNS-010
Scenario: 지시를 받은 요청과 시간상 뒤의 요청을 구분한다
  Given 모델 요청 A의 snapshot이 지시 없이 이미 확정되었다
  When 사용자가 지시 D를 접수한다
  And 요청 A가 초안 V1을 생성한다
  Then V1에는 D의 직접 적용 연결이 없어야 한다
  When 다음 요청 B가 D를 포함한 snapshot으로 시작한다
  And B가 초안 V2를 생성한다
  Then D는 B에 전달된 상태여야 한다
  And V2는 B와 D의 직접 적용 경로를 보여야 한다
  And 지시 준수 판정은 별도 평가 상태여야 한다
```

같은 형식으로 partial cancel 후 parent unblock, budget patch vs admission, approval stale, SSE replay gap을 작성한다. .feature 파일은 수용 기준의 표현이며 이 패키지가 Cucumber 실행기를 구현했다는 뜻은 아니다. 실제 suite는 동일 ID를 가진 Vitest/Playwright 테스트로 연결한다.

## 7. 실제 LLM 평가

두 모델 프로필의 tool schema, usage, context injection, abort는 API contract smoke다. 작업 산출물 품질은 별도 `eval`이다. 고정된 입력 자료와 같은 역할·기준을 사용하고, 결과를 model ID/config/snapshot과 함께 보관한다.

초기 비교는 단일 agent / 고정 팀 / 스티어링한 팀으로 한다. 평가 항목은 근거 적합성, 완료 기준 충족, 수정 횟수, 사용자 개입 횟수, 총 시간, 알려진 usage와 비용이다. 한두 실행의 결과를 통계적 우월성으로 일반화하지 않는다. 토큰이 줄어도 품질이 나빠졌다면 비용 절감 성공으로 표시하지 않는다.

## 8. UX·성능 검증

Playwright는 1280/1440/1920 폭, keyboard-only flow, drag/connect/delete/undo, IME composition, dialog focus return, reduced motion을 검사한다. 실제 브라우저로 Chromium과 Firefox를 필수, WebKit은 지원 선언 전 smoke한다. Storybook은 waiting reason/긴 한국어·일본어/네트워크 단절/expired directive/unknown usage 상태를 고정한다.

성능 fixture는 20 nodes, 100 executions, 10k events, 50 incoming frames/s다. production build에서 테스트하고 브라우저/CPU/메모리/실행시간을 기록한다. 로컬 command receipt p95 200ms, event-to-UI p95 300ms를 초기 목표로 둔다. 스트림 텍스트 수신량이 가변이면 함께 기록한다. 실제 모델 지연을 frontend 지연으로 섞지 않는다.

## 9. 증거 구조

각 feature의 evidence에는 테스트 명령, exit code, 실행 일시, fixture/schema commit hash, 실패 시 trace, live 여부를 둔다. 비밀키나 private transcript를 공개하지 않는다. RED 증거는 임시 feature branch/작업 기록에 보관하고 보호된 main을 실패 상태로 유지할 필요는 없다.

`test-catalog.json`의 status는 구현 테스트를 실행하기 전까지 planned다. evidence가 없는 테스트를 passed로 변경하지 않는다. `traceability.json`은 요구사항의 완성도를 수치로 과장하기 위한 것이 아니라 빠진 계약을 찾는 자료다.
