# 기능 명세: Reins 상태 계약 (접수·전달·종료)

- 상태: accepted (2026-10-15)
- 범위: [API 계약 §2·§4](../api-contract.md)에 흩어진 정의를 한곳에 모았다.
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

### 전달 방식

지시는 전달 방식을 갖는다. 상태 집합과 위의 전이는 두 방식이 같다.

| 방식 | 뜻 |
|---|---|
| `next_request` | 대상 실행의 다음 요청 snapshot을 기다린다. 진행 중인 응답을 건드리지 않는다 |
| `interrupt` | 대상에서 흐르고 있는 모델 응답을 끊고 곧바로 다음 요청을 만들게 한다 |

- 끊긴 응답은 [중단된 출력](../workbench.md#대화-본문과-중단된-출력)으로 남고 최종 답변이나 성공 증거가 아니다. 그 호출의 사용량은 보고된 값으로, 보고가 없으면 미확인으로 기록한다. 0으로 두지 않는다.
- 도구가 실행 중이면 끊지 않는다. 지시는 그 도구가 끝난 직후의 요청에 실린다.
- 끼어들기는 실행을 끝내지 않는다. 대상 실행 단위는 같은 시도로 이어진다.
- 대상의 어댑터가 `interrupt`를 받지 못하면 Coordinator는 `next_request`로 낮추고 receipt에 낮췄음을 남긴다.
- 지시는 선택적으로 텍스트 첨부를 싣는다. 첨부는 지시가 실린 요청에 출처 표시와 함께 들어간다. 이미지는 싣지 않는다.

### 지시의 출처

| 출처 | 만든 쪽 |
|---|---|
| `user` | 사람이 보낸 합류·끼어들기 |
| `advice` | [감독](advisor.md)의 조언 가운데 접수된 것 |
| `system` | Coordinator가 낸 알림([무인 실행 예산](../product-contract.md#9-사용량과-자원-정책)의 마무리·제출 지시) |

출처와 무관하게 같은 전달 경로와 상태를 쓴다. `advice`와 `system` 지시는 승인·취소·패치·권한을 바꾸지 못하고, 모델에 실릴 때 출처가 드러나게 감싼다.

### 읽히지 못한 지시의 넘겨받기

`queued`에서 `expired`가 된 `user` 지시 가운데 대상이 성공으로 끝난 것은 그 세션의 대기 요청으로 넘겨받는다. 지시의 기록은 `expired`로 남고 지우지 않는다. 대상이 실패한 경우, `not_delivered`, `delivery_unknown`, 그리고 `advice`·`system` 지시는 넘겨받지 않는다. 화면의 표시와 시작 규칙은 [대화 입력 흐름](composer-flow.md#대기-요청과-넘겨받기)을 따른다.

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
5. 종료 뒤 늦게 온 결과와 usage는 `observation.late`와 원래 요청의 사용량 기록으로만 남기고 상태를 되살리지 않는다.

## 5. 수용 시나리오와 테스트

시나리오 원문은 [mvp.feature](mvp.feature)에 있다.

| 확인할 것 |
|---|
| 실행 중 접수한 지시가 다음 요청 snapshot에 정확한 ID로 들어간다 |
| 진행 중이던 요청에 늦게 접수된 지시를 전달로 표시하지 않는다 |
| 접수·대기·요청 포함·전달·결과 생성이 서로 다른 상태로 보인다 |
| HTTP 202 receipt만으로 applied나 준수 완료를 표시하지 않는다 |
| 후손·도구·대기 정리 후에만 cancelled를 확정한다 |
| worker나 후손이 살아 있는데 cancelled를 확정하면 실패 |
| 산출물은 실제 요청 snapshot과 입력 버전 경로로 지시와 연결된다 |
| 지시 접수 이후 시간에 나온 이전 요청의 산출물에 직접 원인을 붙이지 않는다 |
| snapshot 확정 직후 접수한 지시는 다음 요청에만 포함된다 |
| 지시 접수 직후 대상이 종료하면 expired 또는 not_delivered로 표시한다 |
| 취소 fence 이후 신규 admit이나 늦은 callback으로 상태가 되살아나지 않는다 |
| 실행 단위가 돌고 있지 않을 때(시작 전, 승인·질문 대기) 접수한 지시는 `queued`로 남고 그 뒤 첫 요청에 실린다 |
| 끼어들기는 흐르던 응답을 끊고 지시를 다음 요청에 싣되 실행을 끝내지 않는다 |
| 도구 실행 중의 끼어들기는 도구를 끊지 않는다 |
| 끼어들기로 끊긴 호출의 사용량을 0으로 기록하지 않는다 |
| 끼어들기를 받지 못하는 어댑터에서는 다음 요청 전달로 낮추고 그 사실이 receipt에 남는다 |
| 성공으로 끝난 대상의 읽히지 못한 사용자 지시는 대기 요청으로 한 번만 넘겨받는다. 취소·실패·조언은 넘겨받지 않는다 |

## 6. 보안·성능·접근성

- 지시 본문은 사용자 입력이다. 렌더링 시 raw HTML을 실행하지 않는다.
- 상태 배지는 색만으로 구분하지 않고 텍스트를 함께 쓴다(스펙 §10.3).
- 지시 입력 중 IME 조합의 Enter는 전송하지 않는다.

## 7. 실행 중 지시 화면

대화에서 지시를 보내고 그 전달을 따라가는 화면은 [대화 입력 흐름](composer-flow.md)이 정한다. 합류와 끼어들기는 대화의 컴포저 하나로 보내고, 전달 상태는 보낸 메시지의 메타 줄이, 실행 상태와 Run 전체 제어는 활동 바가 보인다.

실행 기록 화면에서 선택한 실행의 상태·관측된 계획·지시 전달 상태는 디자인킷의 AgentSteering으로 묶는다. 도구 활동은 기존 ToolCallGroup을 조합하며, 관측된 계획이나 시간이 없으면 단계 수나 경과 시간을 만들어 표시하지 않는다. 계획·도구·지시 내역의 높이를 제한하고 해당 영역만 스크롤하며, 활동 영역은 이름을 가진 키보드 접근 가능한 스크롤 영역으로 제공한다. 입력 초안과 명령 접수·재전송은 기존 Run·실행 대상 소유권을 유지한다.

이미 접수된 지시에는 삭제 버튼을 표시하지 않는다. Run 전체 제어는 그 범위를 명시한 별도 액션으로 유지한다. Run이 끝난 뒤 시작할 대기 요청은 지시 전달 대기와 구분한다.
