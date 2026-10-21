# CR-046: 개발 Workbench의 대상·공통 소유권 기반

- 승인: 2026-10-21. 상세 구현 계획 후 사용자가 “플랜대로 구현하고 적절한 타이밍에 커밋”하도록 요청했다.
- 기준: `071276873dee4bb51491bf608e604fbb4e123475`. [활성 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)의 P00–P03 첫 묶음.
- 추적: CRL-WBD-001 / C-142·143 / TC-WBD-001-H,N,F. 결정: ADR-039.
- C-143/P03 기반 구현 완료, C-142 엔진 비교/ADR-040 결정 완료. [검증 기록](../evaluation/Development-Workbench-Foundation-2026-10-21.md). 구현 상태는 backlog, 실제 결과는 evaluation에 기록한다. 엔진 qualification을 제품 기능 완료로 간주하지 않는다.

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

## P04: 버전 있는 파일 문서와 사용자 변경

추적: CRL-WBD-002 / C-144 / TC-WBD-002-H,N,F. 같은 승인 계획의 P04를 구체화한다. C-144 구현과 Linux 관련 회귀를 완료했다. [검증 기록](../evaluation/Development-Workbench-Documents-2026-10-21.md).

- 기존 원본/사본 browse·Run 파일 API는 유지한다. 관리 session 사본 전용 document read는 host의 안정된 workspace identity, project/binding/session/generation, 정규화 path와 전체 UTF-8 bytes hash·BOM/EOL·bytes를 제공한다. binary/1MiB 초과는 편집 불가이고 원본/snapshot 저장 endpoint는 추가하지 않는다.
- save/create는 operationId·target·path·baseHash(null은 새 파일)·제출 text·editVersion을 받는다. text의 BOM/줄바꿈/마지막 개행을 임의 정규화하지 않으며 기존 파일 mode를 보존한다. 공통 writer 예약과 기존 lease 안에서 신뢰·현재 사본·path·baseHash를 확인하고 같은 폴더 temp write/flush→원자 replace 또는 exclusive create→disk readback으로 완료한다.
- rename은 원본 hash와 빈 목적지를 확인하며 기존 목적지를 덮지 않는다. delete는 confirmed:true와 원본 hash를 요구하고 복구 checkpoint의 해당 원본 bytes가 실제 보존된 뒤에만 삭제한다. tracked_and_unignored checkpoint에 포함되지 않는 파일은 복구가능 삭제라고 표시하지 않는다. 초기 변경 범위는 최대 1MiB UTF-8 일반 파일이다.
- 접수 transaction에 상대 path·baseHash, save의 submittedHash/editVersion, rename 목적지, delete checkpoint ID를 pending intent로 함께 저장하고 모든 결과에도 보존한다. 원문 text는 원장에 중복 저장하지 않는다. renderer 원요청이 사라져도 해당 파일과 precondition을 조회할 수 있어야 한다.
- admitted 이후 결과는 원래 operation receipt로 조회한다. 동일 ID 요청은 같은 효과를 재실행하지 않으며 다른 내용은 conflict다. 적용/기록/응답이 불확실하면 uncertain과 예약을 보존한다. readback은 제출 editVersion을 돌려주며 UI는 더 새로운 편집을 clean으로 만들지 않는다.
- Corral 내부 예약은 외부 writer에 대한 OS 원자 CAS가 아니다. 직전 hash 확인과 원자 교체 사이 외부 변경 경합 한계를 숨기지 않는다. 파일 내용과 절대 경로를 오류/receipt에 복사하지 않는다.

H는 실제 임시 Git/SQLite에서 read→save/create→disk hash/형식/mode, rename·삭제 checkpoint·receipt 재조회다. N은 stale hash/다른 target/generation·Run writer·symlink/경로이탈·binary/크기·기존 rename 목적지다. F는 IO/receipt 실패와 duplicate/늦은 응답·원자성·uncertain 보존이다. 별도 UI E2E를 먼저 추가하지 않는다.
