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


## P09: 패널 대상과 경로 연결

추적: CRL-WBD-005 / C-149 / TC-WBD-005-H,N,F. 기존 화면을 도킹으로 옮기기 전 대상 참조와 view 수명의 계약을 한곳에 모은다. P10의 배치/도킹/저장은 이 단계에서 추가하지 않는다.

- 현재 chat·graph·Run·파일·변경/검토·산출물·검사·preview의 typed descriptor와 안정적인 view key를 등록한다. key는 해당 host 서비스 범위에서 실제 session/Corral/Run/file/preview 대상을 식별하고 설정 query·패널 위치·일시 UI 상태를 도메인 identity에 넣지 않는다. descriptor는 실행·파일·권한의 새로운 원장이 아니다.
- 현재 URL·deep link·`tab=run` 호환·패널 순서와 기억한 view 우선순위를 보존한다. 명시한 Run/execution/artifact/result 링크는 다른 기억된 대상과 합치지 않는다. URL과 view 사이 변환은 순수 함수로 두고 상호 effect로 URL을 반복 갱신하지 않는다.
- panel mount/unmount는 root/services 소유 Run store·문서 모델·PTY·graph draft를 새로 만들거나 다른 대상으로 돌리지 않는다. 현재 Run과 과거 Run은 각자의 store를 사용한다. SettingsLifecycle·늦은 저장 receipt·queue/초안·Reins 대상은 기존 소유자에 남긴다.
- 파일/preview의 기존 scope·격리 origin·lease 종료 의미와 graph revision/draft key는 유지한다. 새로운 route·원본 쓰기·독립 window·preview 실행 권한은 추가하지 않는다.

대상 변환·다른 host/세션의 key·명시한 과거 Run·반복 mount 구독의 의미 있는 실패를 먼저 확인한다. 기존 navigation/settings/editor/Reins 회귀와 실제 인앱의 deep link·back/forward·설정 왕복을 확인한다. 새 E2E는 먼저 실제 화면을 관찰한 뒤 필요한 경우에만 추가한다.

## P10: 도킹 배치·복구와 키보드 조작

추적: CRL-WBD-006 / C-150 / TC-WBD-006-H,N,F. P09의 대상·수명 계약을 유지하는 승인 계획의 다음 묶음이다. C-150 구현과 Linux 인앱·관련 회귀를 완료했으며 [P10 실행 기록](../evaluation/Development-Workbench-Docking-2026-10-21.md)에 근거와 미검증 환경을 남긴다. [ADR-040](../Decisions.md)의 공개 Dockview/React binding 8.6.1(MIT)을 사용한다. 엔진 qualification과 의존성 설치를 제품 구현·화면 검증 완료로 간주하지 않는다.

- 세션 문맥 pane은 URL이 선택한 session/Run을 따른다. 지속되는 문서 pane은 full WorkspaceTarget(host/project/binding/session/copy generation)·정규화 상대 path·viewId를 가지며 현재 세션으로 임의 변경하지 않는다. layout descriptor가 Run·문서·PTY 상태의 새 원장이 되지 않는다.
- 안정된 workspaceId와 project별로 schemaVersion이 있는 배치 metadata만 저장한다. descriptor·group·size·active view 등 화면 참조만 담고 문서 본문·dirty buffer·자격증명·PTY 입력/출력을 복제하지 않는다. 기존 초안·모델·receipt와 영속화 경로는 별도로 유지한다.
- 잘못되거나 알 수 없는 descriptor는 해당 pane의 placeholder로 표시한다. grid 구조를 복원할 수 없으면 기본 배치로 돌아가되 해석 가능한 문서 참조를 보존한다. 손상된 배치나 layout 초기화가 문서를 닫거나 초안·프로세스를 삭제하지 않는다.
- 문서는 최대 20개, 중앙 문서 그룹은 1~2개이며 보조 그룹과 하단 도크를 제공한다. 대화/구현/검토 preset은 모든 문서 ID를 유지한 채 배치만 바꾼다. 상한에서 기존 문서를 조용히 제거하지 않으며 무제한 floating·별도 window는 추가하지 않는다.
- split·resize·탭/그룹 이동은 view 배치 변경이다. 이동·preset·패널 숨김 때문에 문서를 close하거나 PTY/Run을 stop하지 않는다. 명시 문서 닫기는 기존 저장/버리기/취소와 마지막 view 보호를 거치며, 저장 중 새 편집·미확정 receipt를 clean으로 만들지 않는다.
- PTY는 세션의 단일 TerminalPanel을 사용하고 숨김은 detach다. 프로세스·xterm/parser·문서 모델·graph draft·Run 구독과 SettingsLifecycle의 소유권은 기존 root/services에 남는다. 터미널 종료는 기존 명시 stop 경로로만 수행한다.
- 390px에서는 한 번에 한 활성 그룹을 표시한다. 키보드로 그룹 이동·크기 변경·preset·닫기를 수행하고 논리적 focus를 유지할 수 있어야 한다. 진행 중 Run의 승인·중지는 좁은 화면이나 비활성 도크에 가려 접근할 수 없는 상태가 되지 않는다.
- graph 전용 문서 탭 통합은 P18에서 다룬다. P10은 기존 graph/review route·deep link·설정 왕복·D&D·Reins의 의미를 보존하며 이를 조용히 대체하거나 제거하지 않는다.

H는 문서 이동·preset·reload 뒤 같은 문서 ID/모델과 문맥 대상, 명시 닫기, 실제 키보드/390px의 승인·중지 접근이다. N은 다른 workspace/project/사본 참조 구분, 잘못된 descriptor, 상한에서 기존 문서 보존이다. F는 grid/저장 metadata 손상, 저장 중 이동·늦은 receipt·PTY 출력 중 숨김에서 초안과 프로세스 보존이다. 의미 있는 실패 테스트를 먼저 확인하고 기존 관련 회귀를 재사용한다. 새 E2E는 인앱 브라우저에서 실제 필요성을 확인한 뒤에만 추가한다.

## P11: 캡처한 컨텍스트와 대화 표시 밀도

추적: CRL-WBD-007 / C-151 / TC-WBD-007-H,N,F. 승인 계획 P11을 구체화하며 등록 시점에는 구현 전이다. 기존 TextAttachment에 optional provenance를 더하고 첨부·세션 요청·큐·원래 command ID 복구 경로를 재사용한다. 새 RunReference kind나 실행 원장은 추가하지 않는다.

- 사용자가 선택한 코드, 터미널 출력/오류, 파일 hunk, 검사 결과를 캡처 시점의 본문과 출처·version·range로 첨부한다. 첨부의 text/bytes/sha256는 실제 전달할 선택 본문을 검증한다. 기존 64KiB/5개 텍스트 첨부 상한을 유지하고 초과 내용을 조용히 자르지 않는다. provenance 없는 기존 첨부도 계속 유효하다.
- provenance는 사용자가 제공한 읽기 전용 캡처 출처이며 파일 권한·서버가 증명한 최신 상태·쓰기 허가가 아니다. 모델 입력에도 캡처 출처와 source data라는 구분을 전달한다. 같은 본문이라도 출처가 다른 첨부는 합치지 않으며 동일성·중복 검사는 본문 hash와 provenance를 함께 사용한다.
- 코드는 full WorkspaceTarget·상대 path·saved/draft 구분·baseHash·캡처한 전체 bufferHash/editVersion과 1-based line/UTF-16 column, end-exclusive 범위를 보존한다. dirty 선택은 저장된 파일 내용과 구분해 명시 확인 후 전달한다. 확인 대기 중 편집이 바뀌어도 처음 보여준 캡처를 자동 교체하지 않는다.
- 터미널은 full WorkspaceTarget·terminalId/generation·적용 완료 output sequence와 0-based/end-exclusive 셀 범위·cols/rows·normal/alternate buffer를 보존한다. 선택한 평문만 첨부하며 새 출력 로그/serializer를 만들지 않는다. scrollback 제거·resize·buffer 전환으로 원래 위치를 재현할 수 없으면 그 한계를 표시한다.
- hunk와 검사는 writable WorkspaceTarget과 다른 읽기 전용 snapshot 출처다. 실제로 있는 host/project/session과 고정 from/to tree·상대 path·patchHash/hunk IDs 또는 verificationId·tree·fingerprint/configRevision/outputHash 등을 사용한다. 역사 자료에 현재 사본 generation을 붙이거나 이를 위해 report target API를 추가하지 않는다. 검사 outputHash는 redaction 전 원본 stream/report version이고 첨부 sha256는 표시된 선택 본문 hash이며, 범위는 표시된 출력 기준이다.
- 칩은 캡처 내용 확인·원본 이동·명시 교체·삭제와 stale/원본 불가 상태를 제공한다. 원본 변경이나 조회 실패로 캡처 본문을 자동 갱신·삭제하지 않는다. 원본 이동에서 다른 generation·tree·terminal을 같은 출처처럼 바꾸지 않으며 위치 재현이 불가능해도 캡처 본문은 읽을 수 있다. stale 표시는 UI 상태이고 이미 고정한 요청 payload를 바꾸지 않는다.
- 텍스트 첨부는 next와 queue에 보존한다. queued next의 미리보기·편집·수동/자동 시작은 entry에 고정한 첨부를 사용하고 command seed/원래 요청 identity에 전체 metadata를 포함한다. queue 전송 뒤 소비한 텍스트 첨부를 별도 draft에 남겨 혼동시키지 않는다. 이미지는 기존 next-only 경계를 유지한다. steer/explain은 이 첨부를 조용히 누락한 채 전송하지 않으며 다음 요청용임을 알리고 명시 선택을 요구한다.
- source 캡처·교체와 전송 완료는 원래 session/대상·draft revision에 귀속된다. 늦은 응답이 새 초안이나 다른 세션을 지우지 않으며 retry는 원래 command ID·고정 본문을 재사용한다. 현재 Run의 입력·prompt snapshot이나 이미 접수된 queue entry를 소급 변경하지 않는다. 기존 조합 입력/IME·보내기 키 동작을 유지한다.
- 결과/기본/상세 활동의 세 가지 밀도는 기존 projection을 보여주는 선택이다. 원본 이벤트·prompt 기록·도구 결과를 삭제하거나 실행 모드·예산·Reins 대상을 바꾸지 않는다. 승인·실패와 필요한 조치는 접힌 상세 밖에서도 발견하고 접근할 수 있어야 한다.

H는 선택 snapshot→칩→next/queued next→실제 prompt, 원본 이동/교체/삭제와 세 표시 밀도다. N은 다른 출처의 동일 본문 구분, saved/dirty·UTF-16/terminal 좌표·고정 snapshot 범위, 잘못된 hash/상한·조용한 누락 거절이다. F는 늦은 캡처/확인/전송·원래 ID retry·원본 소실과 queue 자동 시작에서 원래 본문/초안/대상 보존이다. 먼저 의미 있는 실패를 확인하고 기존 compose/queue/late/IME 회귀를 재사용한다. 실제 인앱에서 확인하기 전에 새 E2E를 추가하지 않으며 유료 모델을 검증의 기본값으로 사용하지 않는다.

## P12: 읽기 전용 Git 관찰과 실행 정책 분리

추적: CRL-WBD-008 / C-152 / TC-WBD-008-H,N,F. 승인 계획 P12와 D5의 관찰 경로를 구체화하며 등록 시점에는 구현 전이다. 원본 폴더와 관리 사본의 실제 사용자 index를 읽는다. 읽기 요청은 인간 operation 원장에 새로 접수하지 않으며 Run·공통 writer·기존 내부 snapshot helper의 의미를 바꾸지 않는다. P13/14의 hook·credential helper·signer 실행 허용까지 승인됐다고 간주하지 않는다.

- `UserGitTarget`은 `{kind:'session', ...WorkspaceTarget}` 또는 `{kind:'project', hostId, projectId, bindingId}`다. 원본도 읽기 전용으로 지원하므로 아직 commit이 없는 unborn 저장소를 관찰할 수 있다. 서버가 현재 binding·canonical root와 관리 사본 generation을 해석하며 클라이언트 target은 권한을 부여하지 않는다. 원본 쓰기·stage/commit/branch/remote 작업은 이 묶음에 포함하지 않는다.
- `WorkspacesApi.gitStatus(scope: FileBrowseScope)`는 기존 browsePath의 `GET /git/status`에서 현재 target을 발견한다. `gitDiff(scope, {target, side, path, head, indexHash})`는 `GET /git/diff`로 선택한 기준을 읽으며 side는 staged/unstaged/untracked, head는 Git OID 또는 null이다. 상세 HTTP/Zod/client 계약은 소스 구현과 함께 API 정본에 반영한다.
- status는 target, HEAD·branch·upstream/ahead/behind와 detached/unborn/shallow, staged/unstaged/untracked·rename을 구분하는 목록, `indexHash`, `truncated`, `filtersDisabled`를 반환한다. upstream이나 비교 정보가 없으면 그 상태를 명시하고 임의로 0 또는 clean으로 표시하지 않는다. `indexHash`는 해당 원본/사본의 실제 index를 읽은 `ls-files --stage -z`의 semantic content hash이며 index가 없으면 빈 출력의 hash다. Corral 임시 index와 `refs/corral/` snapshot을 사용자 index로 대신하지 않는다.
- staged diff는 HEAD→index, unstaged는 index→작업 파일, untracked는 absent→작업 파일이다. before/after는 기존 text/binary/too_large/absent FileSide 형태를 재사용하고 symlink/gitlink/unmerged 등 지원하지 않는 비교는 사유를 명시한다. diff는 요청의 정확한 target·HEAD/index와 읽기 전후 기준을 확인하며 변경되면 `REVISION_CONFLICT`로 거절한다. 외부 index를 잠그거나 사용자 변경을 되돌리지 않는다.
- status 새로고침이 다른 target을 반환하면 기존 파일 선택을 해제한다. 지연된 diff 응답을 다른 project/binding/session/generation의 선택에 붙이거나 새 대상으로 조용히 재시도하지 않는다. 읽기 실패·기준 변경·사본 소실을 변경 없음으로 바꾸지 않는다.
- P12의 전용 읽기 정책은 hooks, clean/smudge/process filters, textconv, external diff, fsmonitor와 lazy fetch를 끄고 optional index write를 금지한다. 내부 snapshot용 helper를 전역 변경하지 않는다. configured filters가 있으면 `filtersDisabled`와 변환 전 원문을 보고 있다는 제한을 UI와 문서에 표시한다. submodule은 `--ignore-submodules=dirty`로 gitlink 변경만 표시하며 내부 dirty 상태를 별도로 조사하지 않는다.
- Git machine format은 NUL 단위로 파싱한다. 상대 경로의 공백·한글·개행을 보존하며 trim·공백 분리·인용 문자열 역변환으로 이름을 바꾸지 않는다. 기존 경로 보호를 유지하고 지원하지 않는 경로 표현은 손실 변환 대신 명시한다. Git argv와 literal pathspec을 사용하며 사용자 경로를 shell 명령으로 만들지 않는다.
- status 출력은 64MiB, 반환 목록은 2,000개, 파일 본문은 기존 1MiB 한도를 유지한다. 목록 제한은 truncated로 알리고 출력 실패·초과나 binary/미지원 형식을 부분적으로 정상인 clean 결과처럼 표시하지 않는다. 모델 연결 없이 읽기를 사용할 수 있다.

H는 실제 임시 Git 원본과 두 관리 사본에서 status discovery·선택 diff·새로고침, staged/unstaged/untracked·rename/binary와 HEAD/branch/upstream의 구분이다. N은 raw 공백/한글/개행 경로, detached/unborn/shallow·미지원 형식·필터 제한과 다른 target/HEAD/index 거절이다. F는 조회 중 외부 index·HEAD·대상 변경, 늦은 응답·Git 실패·출력 상한에서 원래 선택과 명시 실패를 보존하고 hook/filter 등 실행 및 index·원본·내부 snapshot refs 변경이 없음을 확인한다. 의미 있는 실패 테스트를 먼저 실행하고 기존 인증/client/원본 browse·snapshot 회귀를 재사용한다. 실제 인앱 확인 전 새 E2E를 추가하지 않으며 원격 쓰기·유료 호출은 검증에 사용하지 않는다.

## P13: 관리 사본의 파일 stage/unstage와 commit

추적: CRL-WBD-009 / C-153 / TC-WBD-009-H,N,F. 승인 계획 P13과 D5의 쓰기 정책을 구체화한다. D5는 2026-10-22 사용자 결정으로 확정했다: hook은 신뢰 프로젝트에서만 실행하고, 서명 요구는 사용자 signer로 충족하며 실패하면 거절하고, 작성자·서명 설정은 Git 설정의 허용 키만 읽는다. P14 branch·remote와 credential helper는 이 묶음에 포함하지 않는다.

- 대상은 세션 관리 사본(`WorkspaceTarget`)뿐이다. 원본 폴더 target은 `CAPABILITY_DENIED`로 거절한다. 관리 사본은 원본과 object store·refs를 공유하므로 commit object는 공유 저장소에 쓰이지만 원본의 작업 트리·index·checkout branch는 바꾸지 않는다.
- `GitWriteCommand`는 `operationId`, `target`, `expect:{head, indexHash}`와 kind별 내용을 가진다. `stage`/`unstage`는 literal 상대 경로 목록, `commit`은 메시지, 확인 화면에 보인 `staged` 목록, `runHooks`, 선택적 작성자다. commit은 현재 index를 그대로 기록하며 `staged`가 실제 staged 집합과 다르면 `REVISION_CONFLICT`로 거절한다. unstaged·untracked 변경은 보존한다.
- 모든 쓰기는 기존 `WorkbenchOperations.admit`으로 접수해 공통 writer를 잡는다. kind는 `git.stage`/`git.unstage`/`git.commit`이다. 같은 ID·같은 요청은 원래 receipt를 돌려주고 다른 요청은 `REVISION_CONFLICT`다. 응답 유실 뒤 새 ID로 재실행하지 않는다.
- 효과 직전 HEAD·indexHash·staged 집합을 다시 확인한다. commit은 효과 전에 예상 tree를 계산해 intent에 기록한다. 오류·응답 유실·재시작 뒤 판정은 HEAD의 첫 parent가 예상 HEAD이고 tree가 예상 tree면 `succeeded`, HEAD가 그대로면 `failed`, 그 외는 `uncertain`이다. uncertain은 writer를 풀지 않는다.
- 쓰기 runner는 snapshot용 hooks-off helper와 분리한다. 실행은 소유 process group으로 하고 취소·timeout에서 group 종료를 확인한다. Git 쓰기는 문서 저장과 같이 신뢰 프로젝트에서만 접수하므로 비신뢰 프로젝트에서는 hook·filter가 실행될 경로가 없다. 신뢰 프로젝트에서 hook은 `runHooks`가 참일 때만 저장소 설정 그대로 실행하고 그 외에는 `--no-verify`와 비활성 hooksPath로 실행한다. stage는 저장소에 설정된 clean filter를 그대로 쓴다.
- 작성자·서명은 local·global Git 설정에서 `user.name`, `user.email`, `commit.gpgsign`, `gpg.format`, `user.signingkey`, `gpg.program`, `gpg.ssh.program`만 읽어 명시 전달한다. 그 밖의 전역 설정은 계속 읽지 않는다. 작성자가 없으면 요청의 작성자를 쓰고 그것도 없으면 거절한다. 서명이 요구됐는데 signer가 실패하면 `CAPABILITY_DENIED`(signing)로 거절하고 서명 없는 commit을 자동으로 만들지 않는다.
- 실패 결과는 기존 ErrorCode와 `reason`(`locked`, `hook_failed`, `signing_unavailable`, `author_missing`)을 함께 기록한다.
- HTTP는 `POST /api/v1/sessions/:id/worktree/git/operations`와 `GET …/git/operations/:operationId`다. client는 `gitChange`, `gitOperation`이다. Git 창은 관리 사본 source에서만 쓰기 조작을 보이며 진행 중 operationId를 보존해 다시 열면 같은 ID로 조회한다.

H는 실제 임시 저장소와 관리 사본에서 stage→unstage→commit, 같은 ID 재요청, `runHooks`에 따른 hook 실행/미실행과 SSH 서명 commit이다. N은 외부 stage·HEAD 변경, 다른 payload, 원본 target, 비신뢰 프로젝트, 서명 요구와 signer 부재 거절이다. F는 hook 실패·취소, index.lock 충돌, commit 후 receipt 기록 실패·응답 유실·재시작에서 중복 commit 없는 판정과 기존 hunk 작업이 관리 사본 index를 바꾸지 않음이다. 원격 쓰기·유료 호출은 쓰지 않는다.

## P14: 관리 사본의 branch 연결·전환과 remote

추적: CRL-WBD-010 / C-154 / TC-WBD-010-H,N,F. 승인 계획 P14를 구체화한다. merge/rebase 충돌 해결, force push, reset, clean은 포함하지 않는다. 실제 외부 push는 검증에 쓰지 않으며 로컬 bare remote로만 확인한다.

- 명령은 P13의 `GitWriteCommand`에 더한다: `branch{name}`은 현재 HEAD에서 새 branch를 만들고 사본을 그 branch에 연결하며 작업 파일은 바꾸지 않는다. `switch{branch}`는 기존 local branch로 전환한다. `fetch{remote}`, `pull{remote, branch}`는 fast-forward만 허용한다. `push{remote, branch, runHooks}`는 현재 branch를 같은 이름의 remote branch로 force 없이 보낸다. 모두 같은 receipt·공통 writer·HEAD/index 사전조건을 쓴다.
- 원본 보호는 원본의 작업 트리·index·checkout branch를 바꾸지 않는다는 뜻이다. 관리 사본은 원본과 refs를 공유하므로 새 branch ref와 remote-tracking ref는 공유 저장소에 생긴다. 원본이나 다른 사본에서 checkout 중인 branch로의 전환은 Git의 거절을 `branch_in_use`로 보여 준다.
- 전환은 추적 변경(staged·unstaged)이 있으면 `dirty_tree`로 거절하고, 활성 writer(터미널·Run·다른 operation)가 있으면 기존 writer 규칙으로 거절한다. 같은 사본의 미저장 문서는 Git 창이 먼저 확인해 전환을 보내지 않는다.
- 원격 작업은 신뢰 프로젝트에서만 접수되므로 사용자 Git 설정의 credential helper·`SSH_AUTH_SOCK`과 전역 설정을 그대로 쓴다. prompt는 끈다. hook은 `runHooks`를 켠 push(pre-push)에서만 실행하고 branch·switch·fetch·pull에서는 끈다.
- 판정: branch·switch는 현재 branch와 HEAD, pull은 HEAD가 확인한 HEAD의 후손인지, push는 `ls-remote`의 remote ref가 현재 HEAD인지로 한다. fetch는 사용자 파일을 바꾸지 않으므로 응답 유실 뒤 결과를 적용됨으로 정리한다. non-fast-forward는 `non_fast_forward`, 인증 실패·없는 remote는 `remote_unavailable`, 잘못된 이름은 `SCHEMA_INVALID`로 거절한다.
- `GitStatus`에 읽기 전용 `branches`(local branch 이름, 최대 200)와 `remotes`를 더한다. Git 창은 branch 메뉴에서 branch 만들기·전환과 fetch/pull/push를 제공하며 force·reset·clean·자동 재시도는 없다.

H는 detached 사본의 branch 생성·연결과 전환, 로컬 bare remote의 fetch·fast-forward pull·push다. N은 remote 이동 뒤 non-fast-forward, 잘못된 이름, 원본에서 checkout 중인 branch, 없는 remote와 거절하는 remote, 추적 변경이 있는 전환이다. F는 push 후 receipt 기록 실패·재시작 뒤 ls-remote 판정, 활성 writer와 미저장 문서가 있을 때의 전환 차단이다.

## P15: 개발 task·preview·검사와 Problems

추적: CRL-WBD-011 / C-155 / TC-WBD-011-H,N,F. 승인 계획 P15를 구체화한다. PTY에서 띄운 서버의 preview, 등록 검사의 자동 실행, task 출력의 tree 고정은 포함하지 않는다.

- 발견은 실행이 아니다. 사본 최상위 `package.json`의 `scripts`만 읽어 후보로 보여 주며 lifecycle script(`prepare` 등)를 실행하지 않는다. 패키지 매니저는 lockfile로 pnpm → yarn → npm 순으로 고른다.
- 시작은 사람이 script를 눌렀을 때만 한다. `TaskStart{operationId, target, script}`를 인간 operation(`task`)으로 접수해 사본 writer를 수명 동안 보유하고, `CommandRuntime`의 사용자 owner(`{kind:'user', hostId, sessionId, operationId}`)로 소유 process group을 만든다. 계획은 별도 `workbench_tasks` 테이블을 예상했으나 기존 human operation 원장과 receipt로 충분해 새 테이블을 만들지 않았다.
- 중지는 process group을 끝내고 정리를 확인한 뒤 `cancelled`로 기록한다. 재시작 뒤 열린 receipt는 `uncertain`이 되며 기록된 process group이 사라진 것을 확인해야 정리하고 writer를 돌려준다. 다시 시작은 명시 클릭으로만 한다.
- preview는 Run의 명령과 사용자 task의 operationId를 모두 받는다. 연결 소유 증명은 사용자 task의 process group에도 적용하므로 다른 프로세스가 연 포트는 거절한다. Studio의 preview 선택은 실행 중인 task를 함께 나열한다.
- 검사는 사용자 task·터미널 writer를 이유로 거절하지 않고 그 시점 tree의 snapshot에서 실행한다. Run writer와 다른 사람 operation은 지금처럼 막는다. 결과는 기존 `tree`·`stale`을 그대로 쓴다.
- Problems 창(`/problems`, 검증 그룹)은 검사 출력과 최근 task 출력에서 사본 내부 상대 경로만 위치로 모은다(tsc `path(l,c)`, `path:l:c`). 절대·상위·`node_modules`·`.git`·`.corral` 경로는 버린다. 이전 tree의 검사 결과는 "이전 상태"로 표시하고, 행은 문서 탭의 정확한 줄·열을 연다.
- strict 저장: task·터미널·Run이 writer인 동안 연 문서는 읽기 전용이다. 그 전에 연 문서를 저장하면 409 `RUN_ALREADY_ACTIVE`를 원문 오류 대신 "실행 중인 작업이나 터미널이 이 사본을 쓰고 있습니다"로 보이고 실행 중 task의 중지 버튼을 둔다. 정리가 확인된 뒤의 저장은 사람이 다시 누른다. 터미널과 Run은 각자의 창에서 멈춘다.
- 도구 창 이름은 "Tasks & preview"(작업·미리보기)로 바꾸고 창 목록의 반복 설명(`toolsHint`)을 없앤다.

H는 fixture의 실제 node http server를 후보에서 시작해 출력·preview 프록시 응답·중지를 확인하고, 검사·task 출력의 위치를 Problems에서 열어 문서의 줄로 이동하는 것이다. N은 발견만으로 실행되지 않음, 다른 프로세스의 포트 거절, 없는 script, task 실행 중 저장 거절과 중지 뒤 저장이다. F는 task 실행 중 검사의 snapshot 실행, 재시작 뒤 사라진 process group의 정리와 writer 반환, 이전 tree의 결과 표시다.

## P16: Alpha 통합 인수

추적: CRL-WBD-012 / C-156 / TC-WBD-012-H,N,F. 승인 계획 P16을 실제 앱에서 확인한다. 새 제품 계약은 없다. 인수 중 찾은 결함 두 건만 고친다. 하나는 사본이 없을 때 task 후보 조회가 404를 내던 것이고, 다른 하나는 디스크 충돌을 해결한 뒤에도 저장 실패 안내가 남던 것이다.

- 정상 흐름 두 가지를 확인한다. 첫째는 모델 없이 사본 생성 → 문서 탭 편집·저장 → task 시작과 preview 응답 → 검사 → Git 창의 변경 확인 → 선택 stage → commit → 새 branch → 로컬 bare remote push다. 둘째는 결정적 agent 요청 1회가 사본을 바꾸고 사람이 그 결과를 commit·push하는 흐름이다.
- 반례는 실패한 검사의 Problems 위치와 편집 뒤 이전 상태 표시, 디스크 충돌의 초안 보존, 설정 대화상자 왕복 뒤 commit 초안 유지, 잘못된 branch 이름이다. 응답 유실 반례에서는 host가 처리한 commit의 응답을 잃은 뒤 reload하면 같은 ID로 receipt만 읽는다.
- 모든 흐름에서 원본 폴더의 HEAD·작업 트리·index는 바뀌지 않는다.

통과는 Linux·Chromium·server build의 결과다. 설치판·다른 OS·외부 원격·서명 commit의 qualification이 아니다.

## P17: 변경 검토와 근거 연결

추적: CRL-WBD-013 / C-157 / TC-WBD-013-H,N,F. 2026-10-23 재검토(계획의 “P17 이후 재검토 반영”)에 따라 새 검토 도구 없이 기존 댓글·Diff·hunk 첨부·읽음·판단·검사 결과의 의미를 나누고 근거를 연결한다. 새 증거 DB·Coordinator 원장·별도 Review Center는 만들지 않는다.

재사용: 비교 범위는 기존 `ChangeScope`(세션·읽음 기록 이후·Run)와 `from/to` tree, 의견은 `from/to/path/side/range/quote`의 ReviewService, 선택 hunk는 `from/to/path/patchHash/hunkIds`, 검사는 `verificationId/tree/fingerprint/configRevision`과 실행 당시 명령(`command_json`), Git의 HEAD→index·index→worktree는 Git 창의 P12 모델을 그대로 쓴다.

- **읽음·검토·판단·반영을 나눈다.** 파일 읽음은 기존처럼 내용(`path@afterBlob`)에 귀속하는 브라우저 표시다. 변경 검토는 `[host, path, beforeBlob, afterBlob]`에 귀속한다. 같은 blob 쌍은 같은 변경이므로 사본 generation은 넣지 않는다. 같은 최종 내용이라도 다른 기준의 Diff는 검토하지 않은 것으로 보인다. 검토를 표시하면 읽음도 함께 남고, 해제해도 읽음은 남는다. 파일 목록은 검토(✓)와 “다른 비교에서 읽음”을 구분한다. 헤더의 “지금까지 모두 읽음”은 사본 전체를 읽음 기록으로 남기는 기존 `/reviewed`이며 파일 검토·승인이 아니다. 판단은 ReviewService의 정확한 from/to에만 해당하며 다른 비교의 판단은 “이전 버전 기준”으로 보이고 반영 계획을 열지 않는다. 원본 반영·Git stage·commit은 각자의 별도 행동이다.
- **출처 귀속.** `FileChange.provenance`에 `mixed`를 더한다. Corral이 마지막으로 적용한 write/delete/move가 남긴 내용 hash와 비교 끝 tree의 내용이 같으면 `managed_agent`, Corral이 바꿨지만 그 뒤 다른 쓰기가 섞였으면 `mixed`, Corral이 바꾸지 않았으면 `external_observed`다. 시간으로 작성자를 추정하지 않는다(CR-012 유지).
- **검사의 현재 유효성.** `VerificationView.configChanged`는 결과의 명령 정의가 프로젝트의 현재 등록 명령과 다르거나 삭제됐을 때 true다. 다른 검사를 바꿔 revision만 오른 경우는 해당하지 않는다. 기록·`tree`·`stale` 의미는 바꾸지 않는다. Problems는 이전 tree(“이전 상태”), 이전 설정(“이전 설정”), 버전이 없는 task 출력(“버전 모름”)을 나눈다. task 출력은 최신으로 표시하지 않는다.
- **출처 무결성과 현재 적용성.** 첨부 확인의 `state`(current·stale·unavailable)는 고정 출처를 캡처대로 다시 읽을 수 있는지다. 새 `applies`는 지금 사본에 그대로 해당하는지다. hunk는 현재 세션 tree와 `to`에서 그 파일이 같으면 `yes`, 다르면 `files_changed`다. 검사는 `stale`이면 `files_changed`, `configChanged`이면 `config_changed`다. 확인할 수 없으면 `unknown`이다. 예: “캡처와 원본이 일치함 · 현재 파일은 이후 변경됨”. 오래된 자료도 사람이 첨부할 수 있지만 현재 코드의 검증·수정 근거로 자동 승격하지 않는다.
- **늦은 응답.** 검토 화면은 Run 목록·의견을 읽은 세션과 함께 보관해 세션 전환 뒤 이전 세션의 답이나 초안·진행 Run이 새 세션에 쓰이지 않는다. 검토 표시는 세션별 저장 키에서 다시 읽어 다른 세션의 표시를 쓰지 않는다. 첨부는 기존처럼 캡처 대상 host·project·session이 현재와 같을 때만 요청 초안에 들어간다.
- 화면 정리: 비교 선택의 시각 라벨은 옵션이 스스로 설명하므로 숨기고 접근 가능한 이름은 유지한다. 변경 조각 영역의 반복 설명을 빼고 제목을 “변경 조각”으로 바꾼다. 같은 영역의 미리보기·승인 단계가 대상과 충돌 조건을 보여 준다. 언어 서버 제안은 비어 있으면 빈 상태 한 줄만 보이고, 설명은 제안이 있을 때만 보인다. 새로고침은 접근 이름이 있는 아이콘 버튼이다.

H는 Corral 쓰기만 남은 파일, A→B 검토의 유지, 정확한 비교의 승인과 반영 계획이다. N은 사람이 바꾼 Corral 파일의 `mixed`, C→B에서 검토 미표시와 다른 비교 승인의 이전 표시, 자기 명령이 바뀐 검사, 세션·host가 다른 표시, 버전 없는 task 위치다. F는 이후 바뀐 파일의 hunk 출처 확인과 적용성 분리, 현재 사본을 확인하지 못할 때 `unknown`이다.

통과는 Linux의 단위·통합 결과와 인앱 확인 범위다. 다른 OS·설치판·스크린리더 qualification이 아니다.

## P18: 저장 팀 그래프의 도킹 탭

추적: CRL-WBD-014 / C-158 / TC-WBD-014-H,N,F. 승인 계획 P18 중 P18-A(같은 그래프를 독립 문서 탭으로)를 구현한다. 새 그래프 store·레이아웃 엔진·편집 모델은 만들지 않는다.

- 도킹 descriptor에 `{kind:'graph', projectId, corralId, viewId}`를 더한다. 파일 문서로 가장하지 않으며, 저장 layout에서 같은 프로젝트의 팀만 복원한다. 팀마다 탭은 하나다. 같은 working copy를 두 view가 공유하면 undo·선택이 섞이므로 그래프는 분할하지 않는다. 그래프 탭은 문서처럼 가운데 영역에 놓인다. 다른 프로젝트·중복·형식이 틀린 그래프 탭은 해당 pane만 “사용할 수 없는 pane”으로 바뀌고 다른 문서·PTY는 그대로다.
- 탭 내용은 기존 `TeamDesign` → `Editor`다. route(`/corrals/:id/edit`)와 같은 `editorWorkingCopy`를 쓰므로 탭을 옮기거나 닫았다 다시 열거나 설정·다른 pane을 왕복해도 초안·undo·revision은 같다. 탭 이동·닫기는 팀 정의 저장이 아니다. 미저장 초안은 탭 제목에 `●`로 보인다.
- 세션 안 편집기는 앱 안의 이동(패널·주소 변경)에서 초안 버리기를 묻지 않는다. working copy가 남아 있기 때문이다. 페이지를 닫을 때의 경고는 그대로다. Ctrl+S는 포커스가 그래프 안에 있을 때만 팀을 저장한다. 다른 탭도 계속 mount되어 있어 코드 문서의 저장 단축키가 팀 저장이 되지 않게 하기 위해서다.
- 세션 메뉴의 “팀 설계 열기”는 저장 팀이 있을 때만 보이며 도킹 탭을 연다. 도킹을 열 수 없으면 기존 route로 간다. 세션 안에서는 시험 실행 조작을 보이지 않는다. 세션 Run 제어는 도킹 상단 `DockRunControls` 한 곳이다. 자동 팀에는 편집 링크를 만들지 않는다.

P18-B는 이어서 구현했다(CRL-WBD-015 / C-159 / TC-WBD-015-H,N,F). 새 명령 경로나 조율 엔진은 만들지 않는다.

- **확인 뒤 보내는 명령의 대상 고정.** Run 전체 취소와 execution 취소 확인창은 열 때의 run(과 execution)을 기억한다. 같은 view·store가 다른 Run을 따라가면 확인창이 사라진다. 원래 Run으로 돌아와도 되살아나지 않는다. 누르는 순간 store의 현재 Run이 다르면 보내지 않는다. Reins 지시도 초안의 run이 store의 현재 Run과 다르면 보내지 않는다. 기존 `sendCommand(command)` 형태와 restart의 `expectedControlRevision`은 그대로다. pause·resume은 누른 순간의 Run에 바로 간다. 과거 Run을 보는 동안의 제어 대상 표시는 기존 `DockRunControls`(`viewingOther`)다.
- **execution에서 근거로 이동.** 세션 도킹의 실행 제어 영역에 그 execution이 남긴 것을 보인다. 이 run·execution으로 기록된 broker 파일 쓰기는 검토 화면의 Run 비교 해당 파일로, 그 execution이 쓴 결과는 결과 보기로, 그 execution이 소유한 검사는 Checks로 간다. 결과를 모르는 쓰기는 “결과 모름”으로 표시한다. 다른 Run·execution 기록은 섞지 않고, 다른 세션을 위해 읽은 늦은 응답은 표시하지 않는다. 남긴 것이 없으면 영역을 그리지 않는다. 파일 기록 응답에는 이미 서버가 보내던 `execution_id`를 client 타입에 optional로 더한다.

P18-A 보완: 다른 탭 뒤에 숨은 팀 그래프 탭은 렌더링에서 뺀다(`hidden`). Dockview의 `visibility: hidden`을 canvas 노드의 인라인 `visibility: visible`이 덮어 대화 위에 노드가 그려졌기 때문이다(TC-WBD-014-N).

H는 execution의 파일·결과·검사만 각 화면으로 연결되는 것, N은 다른 Run을 따라간 뒤 Run·execution 취소 확인이 보내지지 않는 것, F는 세션을 바꾼 뒤 이전 세션의 늦은 기록이 표시되지 않는 것이다. host 전환은 services마다 다른 Run store를 쓰는 기존 구조를 따르며 이번에 따로 시험하지 않았다.

H는 같은 팀 탭을 한 번만 열고 문서와 같은 영역에 두며 다시 열어도 그대로 복원하는 것, 초안 변경에 따른 탭 제목이다. N은 중복·빈 ID·다른 프로젝트 팀 거절, 문서 descriptor로의 위장 거절, 세션 안에서 이동 확인과 Ctrl+S 범위다. F는 잘못된 그래프 pane만 안내로 바꾸고 나머지 layout을 보존하는 것이다.

## P21-A: 작업 사본의 보관과 삭제

추적: CRL-WBD-016 / C-160 / TC-WBD-016-H,N,F. 2026-10-23 재검토의 P21-A(로컬 수명)다. 원격 복귀(P21-B)는 C-135와 함께 승인된 실제 host에서 따로 검증한다.

- **보관은 삭제가 아니다.** 세션 보관(`archived`)은 사본·터미널·task를 건드리지 않는다. 사본 삭제는 Changes의 “작업 사본 지우기”에서만 한다.
- **삭제 전 요약.** `GET /sessions/:id/worktree/removal`는 아무것도 바꾸지 않고 다음을 돌려준다.
  - 사본 identity(`bindingId`, `copyGeneration`)와 폴더 존재 여부.
  - 사본 자신의 Git 변경 수(staged·unstaged·untracked·unmerged). 읽지 못하면 `null`이며 깨끗함으로 보이지 않는다.
  - 사본을 잡은 active·uncertain owner. 사람 operation이면 그 종류(task, terminal 등)도 준다.
  - 보내지 않은 검토 의견 수, planned·uncertain 파일 쓰기 수, 끝나지 않은 Run.
  - 저장하지 않은 문서와 복구 초안은 브라우저에 있으므로 Studio가 문서 store에서 더한다.
- 대화상자는 항목이 있을 때만 그 줄을 보인다. owner가 있으면 무엇이 쓰는지 밝히고 삭제 버튼을 잠근다. 서버도 지금처럼 거절한다.
- **generation 고정.** 삭제는 대화상자가 보여 준 `copyGeneration`으로 보낸다(`DELETE …/worktree?generation=N`). 그 사이 사본을 다시 만들었으면 `REVISION_CONFLICT`로 거절하고 새 사본은 그대로 둔다. generation 없는 요청은 기존 호환으로 남긴다.
- **불확실한 정리는 완료가 아니다.** Git worktree 제거와 폴더 삭제 뒤에도 폴더가 남아 있으면 `removed_at`을 기록하지 않고 거절한다. 사람은 그 사본을 “폴더가 사라짐” 또는 남은 상태로 보고 다시 처리한다.
- `.env`·키 자동 복사와 setup 자동 실행은 추가하지 않는다. 복구는 지금처럼 명시 동작이다.

H는 Git 변경·미제출 의견·열린 Run이 있는 사본의 요약과, 보관 뒤에도 사본이 남는 것이다. N은 owner가 있으면 삭제 거절, 요약에 owner 종류 표시, 이전 generation 삭제 요청 거절과 새 사본 보존이다. F는 일부만 지워진 사본을 삭제됨으로 기록하지 않는 것과, 읽지 못한 Git 상태를 모름으로 보이는 것이다.

## P22: 공유 개발 owner (D2 승인)

- 승인: 2026-10-23. 사용자가 `00d19ff`의 D2 결정 자료에서 **B안(공유 개발 owner)**과 §3의 의미를 문서 그대로 승인했다. C-161로 구현했다. strict가 기본이며 명시적으로 공유 개발 모드를 켠 관리 사본만 아래 확장을 적용한다.
- 구현 방식
  - 사람 operation은 `WorkbenchOperations.admit`의 공통 예약으로 접수한다(`document.*`, `git.*`, `task`, `terminal`).
  - 공유 모드는 `development` 사람 operation 하나가 writer를 잡는 방식으로 구현한다. 그 아래에서 문서 저장, 사람이 시작한 task, `git.stage/unstage/commit/fetch/push`는 비-writer access로 접수한다.
  - 후속 P25의 선택 stage/unstage는 같은 허용 의미의 `git.stage_hunks`·`git.unstage_hunks`만 추가한다. 정확한 index·patch 재검증을 유지하며 merge/rebase 시작·continue/abort를 공유 허용으로 확대하지 않는다.
  - `terminal`, `git.branch/switch/pull`, agent writer(Run)는 기존처럼 writer 충돌로 거절한다. 거절 문구에는 공유 모드를 밝힌다.
  - 모드는 별도 열을 두지 않고 원장의 running/uncertain `development` operation으로 판정한다. host 재시작 뒤에는 uncertain이 되어 자동으로 되살아나지 않는다.
  - strict 복귀는 그 사본의 다른 사람 owner가 없을 때만 한다.
  - 원격 host 제외: 서버는 자신이 원격인지 모른다. host 단위 opt-in(`ServerOptions`)을 두고 로컬 실행 경로(desktop sidecar, `corral dev`)만 켠다.
  - 검사의 snapshot 허용(`writerBlocksCheck`)에는 `development`를 더한다.
- 추적: CRL-WBD-017 / C-161 / TC-WBD-017-H,N,F. 계약 등록 뒤 의미 있는 red 시험을 확인했으며 [C-161 실행 기록](../evaluation/Development-Workbench-Shared-Development-2026-10-23.md)에 결과·환경·한계를 남겼다.

- 승인된 B안의 나머지 의미: 파일 저장은 기존 base hash CAS를 유지하고 task의 외부 쓰기와 충돌하면 초안을 보존한다. 감시로 모든 쓰기를 포착했다고 주장하지 않으며 공유 중에는 외부 변경 가능을 표시한다. P17의 external_observed/mixed·검사/검토 snapshot·stale 기준을 유지한다. copyGeneration은 사본 재생성 때만 증가한다.
- 원장과 API: `GET .../worktree/development`는 현재 target·지원 여부·development receipt를 읽는다. `POST`는 `{operationId,target}`로 명시 진입하며 같은 ID/본문은 새로 접수하지 않고 현재 모드 상태를 돌려준다. 원래 receipt는 원장에 보존하며 종료된 ID로 다시 켜지 않는다. `POST .../development/:operationId/finish`는 `{target}`으로 그 owner만 끝낸다. 재시작으로 uncertain인 owner도 하위 사람 owner가 모두 정리돼야 명시 종료할 수 있다. 종료/진입 응답이 유실되면 기존 ID·상태를 다시 읽고 자동으로 모드를 켜지 않는다.
- host opt-in은 `allowSharedDevelopment`이며 기본 false다. 로컬 desktop sidecar와 `corral dev`만 true로 시작한다. 일반 server/원격 진입은 꺼져 있으며 브라우저 입력으로 바꿀 수 없다.
- H: 실제 task 실행 중 저장·Git stage/commit·검사 snapshot과 strict 복귀. N: agent writer·터미널·branch/switch/pull·다른 generation·원격/원본 거절, task 외부 수정의 CAS 충돌. F: 중복/늦은 요청·host 재시작 uncertain, 하위 task/불확실 효과 정리 전 종료 거절. UI는 기존 사본/작업 머리에 같은 모드 컨트롤을 사용하고 새 관리창은 만들지 않는다.

## P23: 프로젝트 언어 세션

- 승인: 2026-10-23 사용자가 기존 기능의 코어 잔여 검증 뒤 P23, P24-A 순서로 구현·관련 회귀·실제 화면 확인·단위별 로컬 커밋을 요청했다. 전체 플랫폼/부하/출시 게이트를 반복하지 않는다.
- 추적: CRL-WBD-018 / C-162 / TC-WBD-018-H,N,F. 기존 agent `lsp_query`와 그 snapshot·승인 계약은 유지한다.
- 신뢰한 관리 사본의 등록 언어 서버를 사람이 실행 구성을 검토하고 명시적으로 시작한다. 현재 copy의 launch fingerprint·config revision을 검증하며 필요한 신뢰는 해당 fingerprint에만 기록한다. 파일 열기만으로 프로세스를 실행하거나 패키지를 설치하지 않는다.
- 한 host/copy generation의 언어 세션은 하나의 process와 server generation을 가진다. 한 client가 dirty 문서 동기화를 소유하며 다른 client는 이를 덮지 않는다. 분할 view는 기존 DocumentStore/model을 공유한다. 실제 copy를 cwd/rootUri로 사용해 tsconfig·import·설치된 의존성을 읽는다.
- 기존 host process capacity와 종료 확인을 사용한다. 이 세션은 공통 원장의 passive nonwriter receipt이며 저장·P22 공유 모드 종료를 막지 않는다. 신원·종료 확인을 보존하고 uncertain 상태는 정리 전 새 시작·사본 삭제·공유 모드 종료를 차단한다. 사본 삭제·프로젝트 신뢰 해제·등록 설정 변경·host 종료 때 먼저 종료하고, 정리를 확인하지 못하면 사본 삭제/새 세션 시작을 거절한다. host 재시작 시 자동 실행하지 않는다. trusted LSP는 OS 파일 쓰기 격리가 아니며 `workspace/applyEdit`와 서버 명령 실행은 허용하지 않는다.
- 문서 didOpen/change/close는 전체 target·server generation·clientId·단조 증가 document version에 고정한다. 동일 버전/동일 본문은 중복 효과 없이 처리하고 다른 본문·역행·다른 세대는 거절한다. 재시작 시 현재 dirty 초안을 다시 보내며 disk save/undo를 대신하지 않는다.
- completion/definition/references는 서버가 지원한 capability만 연결한다. completion은 plain text와 해당 문서 textEdit만 허용하고 command·추가 파일 수정은 실행하지 않는다. 위치는 UTF-16, 결과는 관리 사본의 안전한 상대 경로로 제한한다. 쿼리 중 문서가 바뀌면 늦은 응답을 폐기한다.
- 진단은 server generation·document version을 함께 가진다. 버전 없는 push를 현재 dirty 버전의 결과로 임의 확정하지 않는다. 버전이 확정된 현재 진단만 Monaco marker로 표시한다. 버전을 반환하지 않는 서버의 진단은 기존 Problems에 “버전 미확인”으로 표시하며 다른 check/task 결과와 그 freshness는 보존한다. 진단 수신이 탭·포커스를 바꾸지 않는다.
- 핵심 확인: 실제 JS/TS/TSX fixture에서 dirty 진단·completion·정의/참조 이동, 다른 사본/늦은 버전 차단, crash 후 초안 보존·명시 재시작. 기존 단발 LSP·저장·P22의 관련 코어 회귀만 실행한다.

## P24-A: 읽기 전용 파일 내용 검색

- 같은 2026-10-23 요청으로 P23 이후 구현한다. 추적: CRL-WBD-019 / C-163 / TC-WBD-019-H,N,F. P24-B 교체/refactor는 포함하지 않는다.
- 기존 관리 사본의 파일 열거·ignore·안전한 파일 읽기를 재사용한다. 검색 범위·결과/bytes 상한·취소를 명시하고 binary·대용량·보호 경로는 읽지 않는다. 실행 파일·새 검색 엔진 의존성은 필요가 입증되기 전 추가하지 않는다.
- 결과는 디스크 기준임을 표시한다. 미저장 초안을 검색에 몰래 섞거나 덮지 않으며, 결과는 기존 문서 열기/줄 이동으로 연결한다. 대상·generation·파일 hash가 바뀐 결과는 현재 위치로 단정하지 않고 새 검색을 요구한다. 늦은 쿼리가 새 검색 결과를 덮지 않는다.
- 핵심 확인: 여러 파일의 내용 검색·결과 이동, ignore/binary/한도, 취소·이전 응답·변경된 파일과 dirty 초안 보존. 새 전체 E2E 묶음은 만들지 않는다.

## P20: 미리보기 요소 피드백

- 승인: 사용자가 P20 → P24-B → P25 순서의 구현·기존 동작 보존·핵심 회귀와 실제 화면·단위별 로컬 커밋을 요청했다. 추적 CRL-WBD-020/C-164/TC-WBD-020-H,N,F. 전체 플랫폼·부하·외부 게시 검증은 반복하지 않는다.
- 실제 Desktop preview view를 관측한다. 기존 agent browser는 별도 실행 문맥이므로 사용자가 보고 선택한 화면으로 대체하지 않는다. 새 범용 브라우저·임의 script/CDP API를 renderer에 노출하지 않는다.
- trusted Studio에서 캡처를 시작하고 실제 preview의 요소를 명시 선택한다. 선택 요소의 한정된 텍스트·스타일·화면 영역만 반환한다. 스크린샷과 콘솔 포함은 사람이 고르며, 콘솔은 캡처 대기 중 한정된 항목만 포함한다. 입력값·전체 DOM·앱 인증·preview 권한 토큰을 자동 수집하지 않는다.
- 캡처 전후 lease·동일 view·탐색 세대를 확인한다. 화면을 바꾸거나 닫거나 lease를 폐기하면 늦은 캡처는 거절한다. Esc/명시 취소로 종료할 수 있으며 preview에는 계속 preload·host IPC·앱 cookie를 주지 않는다.
- Studio의 기존 UI에서 내용을 검토하고 명시적으로 대화에 첨부한다. 관측 URL·lease·시간·선택 범위를 표시하고 source revision은 확인 불가로 남긴다. 가변 개발 화면과 Git tree의 원자적 일치를 주장하지 않는다. 대상 host/copy·대화 초안 세대가 바뀌면 첨부하지 않는다. 페이지 내용은 지시가 아닌 사용자 제공 자료다.

## P24-B: 다중 파일 교체와 refactor

- 위 요청으로 P20 이후 진행한다. CRL-WBD-021/C-165/TC-WBD-021-H,N,F. 기존 P24-A 검색과 P23 언어 세션, 파일의 안전한 읽기/CAS·공통 writer를 재사용한다. 사람 효과에 가짜 Run/execution을 만들지 않는다.
- literal replace-all, symbol rename, edit-only code action을 저장된 파일의 불변 before/after diff로 검토하고 명시 적용한다. 미저장/pending 문서를 자동 저장하거나 덮지 않는다. 언어 세대·문서 버전·대상과 파일별 hash를 확인한다. 서버 command나 미지원 파일 동작은 실행하지 않는다.
- code action 요청은 같은 언어 세션·파일의 진단을 후보 탐색 힌트로 사용할 수 있다. 명시 버전이 다른 진단은 제외하고, 버전 없는 진단은 계속 미확인 상태로 둔다. 힌트를 현재 오류의 증거로 승격하지 않으며 반환한 수정안의 현재 문서 버전·디스크 hash·diff 검토는 별도로 요구한다.
- 적용은 공통 사람 writer와 안정된 command ID/receipt를 사용한다. 사전 검사 실패는 쓰기 전에 거절하고 부분 실패는 성공으로 숨기지 않는다. 이미 바뀐 외부 파일을 rollback으로 덮지 않으며 실제 적용/보존/불확실 상태를 보고한다. 응답 유실은 같은 ID로만 조회한다. proposal 작성은 쓰기가 아니다.

## P25: 고급 Git와 충돌 해결

- 위 요청으로 P24-B 이후 진행한다. CRL-WBD-022/C-166/TC-WBD-022-H,N,F. 기존 Git 창·writer·receipt·hook/signer/credential 정책을 유지한다.
- index hunk는 실제 HEAD/index/working 파일과 patch identity에 고정하고 stage/unstage 후 index를 다시 판별한다. checkpoint hunk 승인과 혼동하지 않는다. binary·rename/mode/filter 등 안전하게 표현할 수 없는 경우는 미지원 이유와 기존 파일 전체 작업을 유지한다.
- 충돌은 base/ours/theirs와 현재 파일을 보여 주며 기존 편집기로 해결한다. merge/rebase 진행·continue/abort는 sequencer identity와 현재 index/HEAD를 재검증한다. continue에서 hook/signer·commit 정책을 우회하거나 todo의 exec를 몰래 실행하지 않는다. 지원하지 않는 interactive/autostash/외부 실행 상태는 거절한다.
- abort의 변경 손실 가능을 구체적으로 확인하고 dirty 초안을 보호한다. 자동 merge·force push·destructive reset/clean은 추가하지 않는다. 중복/유실·재시작·실패 후 상태를 다시 읽으며 불확실 상태를 완료로 바꾸지 않는다.
