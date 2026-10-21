# CR-046: 개발 Workbench의 대상·공통 소유권 기반

- 승인: 2026-10-21. 상세 구현 계획 후 사용자가 “플랜대로 구현하고 적절한 타이밍에 커밋”하도록 요청했다.
- 기준: `071276873dee4bb51491bf608e604fbb4e123475`. [활성 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)의 P00–P03 첫 묶음.
- 추적: CRL-WBD-001 / C-142·143 / TC-WBD-001-H,N,F. 결정: ADR-039.
- C-143/P03 기반 구현 완료, C-142 엔진 비교 진행. [검증 기록](../evaluation/Development-Workbench-Foundation-2026-10-21.md). 구현 상태는 backlog, 실제 결과는 evaluation에 기록한다. 엔진 qualification을 제품 기능 완료로 간주하지 않는다.

## 계약

1. 기존 React/Electron·Coordinator·설정·D&D·Reins를 보존하면서 엔진 후보를 격리 fixture로 비교한다. 실제 채택은 버전·라이선스·native runtime·CSP·성능·미검증 범위를 기록한다.
2. 사용자 작업은 가짜 Run을 만들지 않는다. 대상은 host/project/binding/session/copy generation이며 서버가 실제 binding과 사본을 해석한다. 원본·snapshot은 읽기 전용 기본값을 유지한다.
3. 기존 Run과 사용자 operation은 하나의 durable writer 예약을 공유한다. canonical path의 active/uncertain writer는 하나다. 다른 generation으로 이전 불확실 소유자를 우회할 수 없다. snapshot reader는 writer의 효과 전 고정 tree를 관찰한다.
4. operation ID·request hash·대상·예약을 한 transaction에서 접수하고 결과 receipt와 예약 해제도 함께 저장한다. 같은 ID/같은 요청은 원래 receipt, 다른 요청은 conflict다. 재시작의 running은 uncertain이며 자동 재실행하지 않는다. 불확실 예약은 늦은 성공만으로 해제하지 않는다.
5. 기존 session 사본은 generation 1로 이전하며 같은 session 재생성은 증가한다. active reader를 포함한 소유자가 있는 사본 제거를 막는다. Run worker recovery는 Run 예약만 회복하고 사용자 작업을 해제하지 않는다.
6. 초기 구현은 strict writer다. 장기 사용자 PTY와 save의 동시 쓰기는 계획 P22의 별도 결정 전 허용하지 않는다. PTY/task/LSP/DAP는 기존 host process capacity를 공유한다.
7. SQLite migration은 기존 예약/불확실 상태/tree를 보존한다. 기존 단일 서버 소유권과 newer-schema 거절을 사용하며 dual-write lock을 만들지 않는다. rollback은 서버 종료 후 upgrade 전 DB backup과 해당 binary를 함께 복구한다. UI 비활성화는 DB downgrade가 아니다.

## 구현·검증 방식

CR·요구·실패 테스트를 먼저 등록하고 실제로 red를 확인한 뒤 최소 구현한다. 과도한 guard/희귀 조합 테스트, 빡빡한 시간 기준은 추가하지 않는다. E2E를 추가하기 전에 인앱 브라우저+computer use로 필요성을 확인한다. 기존 관련 회귀를 재사용한다.

- H: 기존 DB 이관, 같은 사본 사용자/Run writer 충돌과 다른 사본 병행, 원래 reader tree, operation receipt 재조회.
- N: 다른 payload/오래된 generation, active reader 중 사본 제거, Run recovery가 사용자 예약을 해제하지 않음.
- F: 접수/완료 transaction 실패의 원자성, 재시작과 늦은 완료의 uncertain 보존.

파일 save/PTY/Git의 사용자 공개 API는 후속 작업별로 계약과 검증을 확장한다. 이번 기반만으로 해당 기능 지원을 선언하지 않는다. 유료 호출·외부 push/deploy/merge는 이번 구현 승인에 포함하지 않는다.
