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

## P05–06: 공유 문서 모델·복구·FilePanel 편집

추적: CRL-WBD-003 / C-145·146 / TC-WBD-003-H,N,F. P04의 API를 연결하는 같은 승인 계획의 다음 묶음이다. C-145·146 구현과 Linux 인앱/관련 회귀 결과는 [실행 기록](../evaluation/Development-Workbench-Editor-2026-10-21.md)에 남겼다. 구현과 실제 환경의 검증 상태는 별도로 기록한다.

- Studio workspace client별 root store가 서버의 host/project/binding/session/generation/path identity로 단일 Monaco 모델을 소유한다. view는 selection/scroll과 editor만 소유한다. 설정·route 이동이나 view unmount가 모델/undo/초안을 폐기하지 않으며 독립 창의 동기 편집은 제공하지 않는다.
- 명시 저장은 제출 text/editVersion과 같은 operation ID를 기억한다. 성공 baseline은 제출 내용이며 그 뒤 입력은 dirty로 남는다. 응답 유실은 원래 receipt GET으로 확인하며 새 ID로 자동 재전송하지 않는다. 충돌에는 base/내 초안/현재 disk를 보존하고 명시 해결을 제공한다. 마지막 view의 닫기는 저장/버리기/취소이며 저장 뒤 새 편집·미확정 작업이 있으면 닫지 않는다.
- 표준 IndexedDB는 renderer별 identity와 full document key로 초안을 저장한다. 다른 창의 후보를 자동 채택하거나 덮지 않는다. 복구는 명시 선택이며 stale disk와 과거 baseline을 함께 보여준다. transaction 완료를 복구 저장 ack로 사용하고 quota 오류를 표시하며 메모리 초안은 유지한다. crash 직전 ack되지 않은 입력의 영속화를 보장하지 않는다. 본문·절대 경로를 로그/telemetry에 기록하지 않는다. 삭제·재생성된 사본의 과거 초안은 같은 host/project/session의 읽기 전용 후보로 재시작 후에도 접근하며 새 사본으로 자동 적용하지 않는다.
- Monaco public API와 지연 로딩, 기존 토큰·공용 control을 사용한다. LF/CRLF·BOM은 보존한다. Monaco가 원형을 표현할 수 없는 CR-only/mixed EOL은 원문을 보존한 읽기 상태에서 LF/CRLF 명시 변환을 선택한 뒤에만 dirty 편집으로 바뀐다. 별도 undo 엔진이나 무음 정규화를 추가하지 않는다.
- 관리 사본 text만 편집하고 원본·demo·binary·대용량은 기존 읽기 fallback을 유지한다. 저장되지 않은 range를 저장된 파일 reference로 오인시키지 않는다. tab 상한 도달 시 기존 문서를 조용히 제거하지 않고 닫기 안내를 제공한다. beforeunload의 기존 Desktop unsaved probe에 문서 상태를 합친다.
- FilePanel에 저장·dirty/read-only·충돌·복구 경로를 텍스트와 접근 가능한 상태로 표시한다. 편집기 내부 저장 단축키는 조합 입력을 가로채지 않는다. 390px·키보드 focus·테마·worker/CSP·실제 저장→기존 Diff를 확인한다. 자동 입력을 실제 OS 한/일 IME 검증으로 보고하지 않는다.

먼저 모델/복구의 의미 있는 실패 테스트를 확인한다. 기존 관련 회귀를 재사용하고, 새 E2E는 인앱 브라우저 관찰 후 필요할 때만 추가한다. 이 계약의 정본은 CR-046이며 UI/상태 소유자는 Studio, 변경 시 관련 TC와 실제 화면을 재검증한다. 새로운 저장·충돌 UI는 기존 read-only browse를 대체하지 않고 관리 사본 text에만 적용한다.

## P07–08: 사용자 PTY와 terminal view

추적: CRL-WBD-004 / C-147·148 / TC-WBD-004-H,N,F. 승인 계획의 strict writer·별도 사용자 owner·공통 host capacity를 유지한다. 아래의 Linux 우선 구현이 다른 OS 또는 전체 설치판 검증을 대신하지 않는다.

- 사용자 PTY는 fake Run 없이 관리 사본 target/generation, 원래 create operation ID와 durable receipt로 소유한다. 현재 신뢰와 canonical 사본을 확인하고 효과 전 snapshot과 공통 writer 예약을 유지한다. 프로세스가 쓰기 가능한 동안 save/다른 writer를 허용하지 않는다. UI는 터미널 종료 확인 후 저장하거나 다른 사본을 선택하도록 안내한다.
- node-pty는 host의 번들 Node에서 실행한다. 기존 host 12개 process-group capacity를 공유하고 서비스별 counter를 만들지 않는다. 별도 PID group의 일반 shell job도 포함한 OS 소유 단위를 확인한 뒤에만 writer/capacity를 해제한다. Linux는 bootId/PID/startTicks/SID identity와 실제 구성원 확인을 재사용한다. SID 밖으로 의도적으로 daemonize한 프로세스를 sandbox/완전 종료했다고 주장하지 않는다. 모호한 소유는 uncertain으로 남긴다.
- shell은 기존 설치 shell 목록에서 선택하며 원본 폴더에서는 실행하지 않는다. 기존 allowlist 환경과 private HOME을 재사용하고 provider/bootstrap 자격증명이나 사용자 shell 시작 파일을 자동 전달하지 않는다. pane 숨김/route 변경은 detach이며 명시 stop과 다르다. Run 취소는 사용자 PTY를 종료하지 않는다.
- 기존 HTTP cookie/Host/Origin/CSRF와 SSE를 사용한다. create/claim/stop은 기존 요청 상한을 유지하고 input/resize에만 작은 frame/byte 예산을 별도로 적용한다. 인증을 완화하거나 전체 쓰기 상한을 올리지 않는다. 입력·출력 본문을 영속 receipt/log/레이아웃에 복제하지 않는다.
- 한 controller generation/attachment만 input을 보낸다. 단조 sequence와 동일 payload hash로 중복 요청을 재실행하지 않으며 ack는 host 접수이지 shell 완료가 아니다. reconnect는 지난 입력을 자동 재전송하지 않는다. 명시 takeover는 이전 controller를 무효화한다. resize는 현재 controller의 최신 크기로 수렴한다.
- output generation/sequence와 최초 크기·성공한 resize를 포함한 처음부터의 raw 기록을 byte 상한 안에서 재생한다. 정상 view는 마지막 적용 sequence 다음부터 연결하고 새 view는 처음부터 재생한다. 상한을 넘으면 replay 불가를 명시하고 임의 ANSI tail을 정상 복구로 표시하지 않는다. 느린 SSE viewer만 분리하며 shell을 자동 종료하지 않는다. headless/serialize/WS 의존성은 이 첫 계약에 필요하지 않다.
- host 재시작은 기존 PTY를 복원하거나 command를 replay하지 않는다. 이전 operation/OS identity를 읽고 종료 확인 또는 uncertain을 구분한다. 입력 소유권과 출력 재생은 새로운 renderer attach와 별도로 관리한다.
- xterm은 자체 terminal parser를 대체한다. Unicode/ANSI/alt-screen·resize·선택/복사·접근성을 사용하고 OSC clipboard/title/link를 이유로 명령·URL을 자동 실행하지 않는다. 상태/종료/입력 권한은 터미널 밖의 공용 control에서도 발견 가능해야 한다.

먼저 실제 발견된 별도 PGID 후손·split escape와 핵심 상태 경합의 red를 확인한다. 시간은 runaway 상한만 사용하며 불필요한 exhaustive matrix나 새 E2E를 추가하지 않는다. 새 E2E가 필요하면 먼저 인앱 브라우저에서 실제 흐름을 관찰한다. 유료 모델·원격 push·배포·merge는 이 구현에 포함하지 않는다.
