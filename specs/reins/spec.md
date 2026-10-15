# 기능 명세: Reins 상태 계약 (접수·전달·종료)

- Feature ID: CRL-FEAT-006-reins-contract
- 연결 요구: CRL-RNS-001, CRL-RNS-002, CRL-RNS-003, CRL-RNS-004, CRL-RNS-006, CRL-RNS-010, CRL-SEC-004
- 태스크: C-001(정의 동결). 구현은 C-031–C-036
- 상태: accepted (2026-10-15)
- 변경 사유와 기존 명세 차이: 없음. 스펙 §8과 [API 계약 §2·§4](../../docs/API-Contract.md)에 흩어진 정의를 한곳에 모으고 테스트 ID를 붙였다.
- 비목표: 지시 철회 UI, 부분 대상 적용, 모델의 지시 준수 판정(별도 평가)

## 1. 세 단어의 정의

| 단어 | 성립 조건 | 근거 사실(event) | 성립하지 않는 것 |
|---|---|---|---|
| **접수(accepted)** | Coordinator가 명령의 세션·대상·schema·revision을 검증하고, 명령과 event를 한 트랜잭션으로 commit했다 | receipt `status=accepted`와 `acceptedSeq`, `directive.accepted` / `patch.committed` / `cancel.requested` | HTTP 202 응답 자체. 적용·전달·종료 |
| **전달(delivered)** | 지시를 포함한 ContextSnapshot으로 만든 모델 요청을 로컬 transport가 시작했다 | `directive.attached`(snapshot·modelCallId) 다음 `directive.dispatched` | 모델이 지시를 이해하거나 지켰다는 사실. 진행 중이던 요청의 결과에 지시가 반영됐다는 사실 |
| **종료(terminated)** | 대상 scope의 모든 소유 후손 worker, backend 도구 요청, 대기 promise가 종료 또는 취소 결과로 정리됐다 | `cancel.confirmed`(settlementRefs)와 대상의 terminal `execution.settled` | `cancel.requested`. 원격 공급자의 처리·청구 중단 |

## 2. 지시 전달 상태

```text
accepted → queued → attached_to_request → delivered
   │          │              │
   │          │              └─ 응답 전 연결 단절 → delivery_unknown
   │          ├─ 요청 전 대상 취소 → not_delivered
   │          └─ 요청 전 대상 종료 → expired
   └─ 검증 실패 → rejected
```

| 현재 | 다음 | 조건 | 기록 |
|---|---|---|---|
| (없음) | `accepted` | 명령 검증과 commit | `directive.accepted` |
| (없음) | `rejected` | 대상 없음·권한 없음·schema 오류. 이미 종료된 대상은 `TARGET_TERMINAL` | receipt `rejected` |
| `accepted` | `queued` | 같은 트랜잭션에서 대상 실행의 대기열에 들어감 | `directive.accepted` 안에 함께 기록 |
| `queued` | `attached_to_request` | 대상 실행의 다음 요청 snapshot 확정 | `directive.attached` |
| `attached_to_request` | `delivered` | 해당 요청의 transport 시작 관측 | `directive.dispatched` |
| `attached_to_request` | `delivery_unknown` | 시작 여부를 확인하기 전 연결 단절 | `directive.undelivered`(reason) |
| `queued` | `not_delivered` | 요청 전에 대상 또는 Run 취소 | `directive.undelivered`(reason) |
| `queued` | `expired` | 요청 전에 대상이 종료 | `directive.undelivered`(reason) |

규칙:

- 한 요청에 지시 여러 개가 붙으면 순서와 ID를 모두 기록한다.
- 이미 snapshot이 확정된 요청에는 새 지시를 붙이지 않는다. 그 지시는 다음 요청을 기다린다.
- 접수된 지시를 기록에서 지우지 않는다. 방향을 바꾸려면 새 지시를 보낸다.
- 산출물의 직접 적용 연결은 그 산출물을 만든 요청의 snapshot에 지시가 포함된 경우에만 만든다.

## 3. 명령 receipt와 적용

| receipt 상태 | 뜻 |
|---|---|
| `accepted` | 접수됨. 효과는 아직 없음 |
| `queued` | 효과가 정해진 경계를 기다림(예: 다음 요청, 다음 활성화) |
| `applied` | steer는 입력 전달 확인, patch는 정책 commit, pause/cancel은 상태 전이 확정 |
| `rejected` | 검증 실패. 오류 코드 포함 |
| `superseded` | 같은 대상에 대한 뒤 명령이 먼저 확정됨 |
| `expired` | 적용 경계 전에 대상이 종료 |
| `cancelled` | 적용 전에 상위 scope가 취소됨 |

patch의 `applied`(정책 commit, `patch.committed`)와 미래 실행이 실제로 쓴 사실(`patch.activated`)은 다르다. UI는 둘을 구분해 표시한다.

## 4. 종료 규칙

1. 취소 의도를 접수하면 같은 트랜잭션에서 대상 scope의 새 admission을 막는다(`cancel.requested`, fenceSeq).
2. 이미 admit된 요청은 Abort가 닿을 때까지 살아 있을 수 있다.
3. 모든 소유 후손과 도구와 대기가 정리된 뒤 `cancel.confirmed`를 기록하고 `cancelled`를 확정한다.
4. timeout 후 강제 종료했다면 `forced=true`를 기록한다. 종료를 확인하지 못하면 `termination_unconfirmed` 실패로 표시한다.
5. 종료 뒤 늦게 온 결과와 usage는 `observation.late`와 정산 기록으로만 남기고 상태를 되살리지 않는다.

## 5. 수용 시나리오와 테스트

시나리오 원문은 [tests/acceptance.feature](../../tests/acceptance.feature)에 있다.

| TC | 확인할 것 | 구현 태스크 |
|---|---|---|
| TC-RNS-001-H | 실행 중 접수한 지시가 다음 요청 snapshot에 정확한 ID로 들어간다 | C-031 |
| TC-RNS-001-N | 진행 중이던 요청에 늦게 접수된 지시를 전달로 표시하지 않는다 | C-031 |
| TC-RNS-002-H | 접수·대기·요청 포함·전달·결과 생성이 서로 다른 상태로 보인다 | C-001, C-018, C-031 |
| TC-RNS-002-N | HTTP 202 receipt만으로 applied나 준수 완료를 표시하지 않는다 | C-031 |
| TC-RNS-004-H | 후손·도구·대기 정리 후에만 cancelled를 확정한다 | C-033 |
| TC-RNS-004-N | worker나 후손이 살아 있는데 cancelled를 확정하면 실패 | C-033 |
| TC-RNS-010-H | 산출물은 실제 요청 snapshot과 입력 버전 경로로 지시와 연결된다 | C-036 |
| TC-RNS-010-N | 지시 접수 이후 시간에 나온 이전 요청의 산출물에 직접 원인을 붙이지 않는다 | C-036 |
| TC-RACE-01 | snapshot 확정 직후 접수한 지시는 다음 요청에만 포함된다 | C-031, C-039 |
| TC-RACE-13 | 지시 접수 직후 대상이 종료하면 expired 또는 not_delivered로 표시한다 | C-031, C-039 |
| TC-SEC-004-N | 취소 fence 이후 신규 admit이나 늦은 callback으로 상태가 되살아나지 않는다 | C-013, C-033 |

P0의 mock 세로 절편(C-004)은 이 중 접수와 `queued` 표시까지만 보여준다. 전달 이후는 P3·P6에서 실제 요청 경로가 생긴 뒤 검증한다.

## 6. 보안·성능·접근성

- 지시 본문은 사용자 입력이다. 렌더링 시 raw HTML을 실행하지 않는다.
- 상태 배지는 색만으로 구분하지 않고 텍스트를 함께 쓴다(스펙 §10.3).
- 지시 입력 중 IME 조합의 Enter는 전송하지 않는다(CRL-UX-001).
