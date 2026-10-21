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
