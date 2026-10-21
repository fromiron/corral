# Corral 제품 헌장

- 태스크: C-001 · 요구: CRL-DEV-003, CRL-RNS-002
- 기준: [현재 제품 계약](../docs/current/product-contract.md), [기능 명세 지도](README.md), [ADR 원장](../docs/Decisions.md)와 해당 기능의 승인 CR. 초기 구현 계획은 역사 자료이며 작업 진입점이 아니다.
- 상태: 동결 (2026-10-15). 아래 항목을 바꾸려면 [변경 요청](../templates/change-request.md)이 먼저다.

## 1. 해석 순서

사용자가 확정한 목표 → 스펙 → 기능별 수용 기준 → 기술 계약 → 구현 태스크 순서로 해석한다(스펙 §0). 테스트가 실패한다는 이유로 명세를 약화하지 않는다. 라이브러리 편의를 이유로 아래 비협상 항목을 빼지 않는다.

## 2. MVP 비협상 항목

| 항목 | 의미 | 요구 |
|---|---|---|
| D&D 편집 | 빈 캔버스에서 노드를 드롭·연결하면 실제 실행 순서가 바뀐다 | CRL-CAN-001 |
| 협업 | 질문·답변·제출, 동적 자식 호출(깊이 2) | CRL-COL-001–004, CRL-RUN-004 |
| 제한된 Loop | Loop 1개, 자동 회차 상한, 상한에서 사용자 확인 | CRL-RUN-003 |
| Reins | 실행 중 지시 접수, pause/resume, 전체·개별 취소, 미래 설정 patch, 승인·반려 | CRL-RNS-001–010 |
| 단일 확정자 | 도메인 상태는 Coordinator만 확정한다. Pi·LangGraph·UI store는 확정하지 않는다 | CRL-RUN-001, ADR-003 |
| 불변 산출물 | `artifactId + version`은 바뀌지 않고, 제출 버전만 다음 단계로 간다 | CRL-ART-001 |
| 정직한 표시 | 접수≠적용, 전달≠준수, 취소 요청≠취소 확정, 미확인 usage≠0 | CRL-RNS-002, CRL-OBS-004 |

현재 경계는 [제품 계약 §3](../docs/current/product-contract.md)와 승인된 후속 CR을 따른다. 초기 계획의 제외·단일 Run·도입 예정 문구로 후속 기능을 되돌리지 않는다.

## 3. 동결한 상태 집합

값의 이름과 의미는 [기술 설계 §6](../docs/Technical-Design.md)과 [API 계약](../docs/API-Contract.md)을 따른다. 여기서는 값의 집합만 고정한다. 구현은 `packages/contracts`의 Zod enum이 이 목록과 같아야 한다.

| 대상 | 값 |
|---|---|
| Run | `created`, `validating`, `running`, `pausing`, `paused`, `awaiting_user`, `cancelling`, `succeeded`, `failed`, `cancelled`, `interrupted` |
| Execution | `queued`, `ready`, `active`, `waiting_children`, `waiting_message`, `waiting_approval`, `pausing`, `paused`, `cancelling`, `succeeded`, `failed`, `cancelled` |
| Execution activity | `model`, `tool`, `finalizing` |
| Task | `queued`, `in_progress`, `blocked`, `submitted`, `completed`, `failed`, `cancelled` |
| Directive 전달 | `accepted`, `queued`, `attached_to_request`, `delivered`, `not_delivered`, `expired`, `rejected`, `delivery_unknown` |
| Command receipt | `accepted`, `queued`, `applied`, `rejected`, `superseded`, `expired`, `cancelled` |
| Review verdict | `pass`, `revise`, `inconclusive` |

종료 상태에서 다른 상태로 돌아가는 전이는 없다. 늦게 도착한 결과는 `observation.late`로만 기록한다(INV-11).

## 4. 접수·전달·종료의 뜻

Reins의 세 단어는 [Reins 기능 명세](reins/spec.md)에서 정의하고 테스트 ID에 연결한다. 다른 문서와 UI 문구는 그 정의를 따른다.

## 5. 착수 조건과 완료 조건

**착수 조건(DoR):** 요구 ID, 정상·거절 경로, 입력·출력 예제, 적용 경계, 변경 소유 패키지, 의존 태스크, 검증 명령이 있다(v0.1 §3.2).

**완료 조건(DoD):**

1. 연결된 TC가 의도한 assertion으로 먼저 실패했고(RED), 최소 구현으로 통과한다(GREEN).
2. 테스트 제목에 `[TC-…]` 태그가 있고 `pnpm spec:check`가 통과한다.
3. 실행한 명령과 결과를 PR 또는 `evidence/`에 남긴다. 실행하지 않은 검사는 통과로 적지 않는다.
4. 외부 호출·시간·ID는 주입하며, 일반 테스트는 네트워크 없이 통과한다.

## 6. 기능 묶음과 태스크

| 기능 묶음 | 단계 | 태스크 |
|---|---|---|
| `001-canvas` | P0–P1 | C-001–C-010, C-051–C-054, C-056 |
| `002-run-coordinator` | P2 | C-011–C-016, C-055, C-057, C-059, C-060, C-062 |
| `003-agent-adapter` | P3 | C-017–C-020, C-058 |
| `004-collaboration` | P4 | C-021–C-025 |
| `005-review-loop` | P5 | C-026–C-030 |
| `006-reins` | P6 | C-031–C-036 |
| `007-limits-recovery` | P7 | C-037–C-041, C-061 |
| `008-live-tools-security` | P8 | C-042–C-045 |
| `009-demo-release` | P9 | C-046–C-050 |

각 묶음 디렉터리(`specs/<묶음>/`)는 해당 단계를 시작할 때 `spec.md`, `plan.md`, `tasks.md`, `acceptance.feature`, `evidence/`로 만든다. 루트 문서를 복사하지 않고 요구 ID를 참조한다. Reins의 상태 계약은 P0에서 먼저 고정하므로 `specs/reins/`에 둔다.
