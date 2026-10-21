---
kind: reference
status: current
baseline: 4bde876
---

# Workbench와 대화 흐름

[CR-043](../change-requests/CR-043-chat-first-optional-corral.md)이 기본 대화·선택적 Corral의 기준이다. 기존 편집기·D&D·Reins는 선택 가능한 작업 경로로 유지한다.

## 기본 입구

새 대화는 입력부터 시작한다. 모델 미연결 시 요청을 보존하고 연결로 안내한다. 새 프로젝트는 대화 목록부터 열되, 명시한 Corral 라이브러리 링크·저장한 탭·편집기 접근은 유지한다.

기본 입력창에는 요청, 첨부·참조, 모델, 권한, 음성, 보내기를 둔다. 선택적 Corral·작업 스타일·품질·역할별 설정·프로젝트 자료·요청 템플릿은 요청 옵션에서 다룬다. 비기본 선택은 옵션을 닫아도 요약한다.

옵션을 숨겨도 값·초안·권한을 초기화하지 않는다. 모델과 명시한 추론 선택을 알아볼 수 있게 표시한다. 고급 옵션의 숨김은 실행 중 Run의 설정 변경이 아니다.

## 범위와 연속성

[CR-045](../change-requests/CR-045-workbench-identification.md): 명시 이름·목적 없이 만든 대화는 첫 저장된 next/queue 요청으로 짧은 제목을 한 번 정한다. 직접 이름을 저장하거나 기존 데이터에서 읽은 이름은 자동으로 바꾸지 않는다. 사이드바의 대화 목록 필터는 제목·목적만 대상으로 하며 별도 세션·결과 검색의 본문 opt-in을 유지한다. 입력 경계는 비포커스 상태에서도 식별하고 좁은 화면 모델명·추론 선택은 잘라 숨기지 않는다.

일반 입력·선택·outline 버튼은 옅은 공용 입력 경계 토큰을 사용하고 포커스는 선명하게 구분한다. 설정의 한 줄 컨트롤은 36px(터치 44px), textarea는 내용 줄 수에 맞춘다. 설정 컨테이너 안의 입력·선택은 기존 surface 배경을 쓰고 API 키 표시 버튼은 입력과 8px 간격 및 같은 높이를 유지한다. 대화 입력 그룹과 메뉴/팝오버는 표면·그림자로 구분하고 키보드 포커스·고대비 모드의 경계·선택 및 오류 표시는 유지한다. 구현·환경별 검증은 [CR-045 기록](../evaluation/Workbench-Identification-2026-10-21.md)을 따른다.

기본 세션은 `corralId: null`과 기존 auto 시작 → Coordinator → Run 경로를 사용한다. 명시한 Corral이 삭제되면 조용히 auto로 대체하지 않는다. 작성 중 내용과 복구 선택을 보존한다.

세션 요청·Run·역할 execution을 구분한다. 큐에는 원래 요청 설정을 보존하며, 늦은 응답이 현재 세션·선택 Run·초안을 덮어쓰지 않도록 한다. 응답 유실 복구는 원래 command ID와 receipt 경로를 따른다.

설정 저장 revision, 미저장 그래프·초안, 복귀 경로, 과거 결과 선택과 Reins 대상을 보존한다. 실행 중 중지·대상 선택·오류·승인은 해당 맥락에서 계속 접근할 수 있어야 한다.

## 검증

키보드로 옵션을 열고 닫으며 Escape 뒤 트리거로 초점이 돌아가야 한다. 390px에서도 입력·전송·복구와 선택 요약이 잘리지 않아야 한다. 실제 화면과 관련 회귀를 함께 확인한다.

현재 근거는 [Chat-first 검토](../evaluation/Chat-First-UX-Review.md), [Desktop 진행 기록](../evaluation/Desktop-Capabilities-Implementation-Progress.md), 해당 UI·서버 시험이다. 로컬 테스트 모델 응답을 외부 모델 품질 증거로 취급하지 않는다.

새 UI 변경은 [AGENTS.md](../../AGENTS.md)의 디자인 스킬·공용 토큰·컴포넌트 규칙을 따른다. 다른 제품의 UI 참고는 Corral의 권한 기본값이나 실행 의미를 대체하지 않는다.

## 문맥형 설정

설정 모달은 제목·닫기 아이콘·범주·본문으로 구성한다. 중복 복귀 링크와 일괄 적용 설명 줄은 두지 않으며 대상·저장 시점은 필요한 개별 폼에서 안내한다. 독립 설정 URL은 작업 복귀 링크를 유지한다. 기본 공통 Dialog는 장식 외곽선 대신 기존 표면·그림자·배경 차폐로 구분하며 키보드 포커스와 고대비 모드 경계는 유지한다.

사이드바는 정상 모델 연결 배지를 상시 표시하지 않는다. 모델 미연결의 연결 진입점과 데모·시뮬레이션 표시는 유지한다. 예약 실행·모든 프로젝트는 세로로 배치하며 전체 프로젝트 화면의 생성·보관·복원 기능을 보존한다.

[CR-044](../change-requests/CR-044-contextual-settings-ui.md)가 설정 표시·저장 수명의 후속 계약이다. 작업 화면의 설정 진입은 같은 작업 URL에 `settings`·선택적 `settingsProject`를 더해 모달을 연다. 작업 Outlet, 초안·첨부·그래프, Run 구독과 과거 결과 선택은 유지한다. 기존 `/settings`와 하위 URL은 동일 폼을 독립 표시한다.

미저장 이동은 저장하고 이동/버리기/계속 편집으로 보호한다. 신뢰·설치·금고 복원 등 명시 확인이 필요한 작업은 자동 저장하지 않는다. 입력 중인 자격 증명은 닫을 때 정리하며, 금고 해독용 비밀번호 자체는 저장할 설정으로 취급하지 않는다. 저장 중 닫아도 요청을 취소하지 않고 원래 대상에 결과·재확인 링크를 남긴다. 원래 publish/채택 명령 ID와 기존 CAS를 보존하며 다른 대상의 완료 응답이 이를 지우지 않는다. 서버 소유 작업 방식의 프로젝트 미리보기 변경은 프로필 저장 대상 변경이 아니므로 초안을 유지한다.

모달 열기는 한 번 push, 내부 이동은 replace다. 현재 앱이 만든 이전 항목을 확인할 때만 back하며 직접 진입/재로드/일회성 새 세션 URL에서는 설정 검색값과 소비된 일회성 플래그를 replace로 정리한다. 늦은 세션 생성 완료는 서버 결과를 보존하되 열린 설정을 닫고 다른 화면으로 이동하지 않는다. 모달 안의 메뉴 Escape와 배경 단축키를 분리하고 닫은 뒤 논리적 작업 위치로 포커스를 돌린다.

Composer 상태·접힌 계획 수·변경 요약은 기존 데이터의 알약으로 표시한다. 변경 요약은 오른쪽 카드와 중복하지 않는다. Todo 본문·대응 필요 조치·Reins와 기존 컨텍스트 상세 팝오버는 유지한다. 모델 선택은 다음 요청임을 표시하며 현재 실행 snapshot·Ultra 의미를 바꾸지 않는다.

C-140의 구현과 이번 Linux 검증은 [실행 기록](../evaluation/Contextual-Settings-UI-2026-10-21.md)에서 확인한다. Windows/macOS·실제 IME·스크린리더 검증과 전체 릴리스 판정은 별도다.

## 관리 사본의 수동 파일 변경

[CR-046 P04](../change-requests/CR-046-development-workbench.md)는 모델 연결 없이 관리 session 사본의 버전 있는 파일 읽기와 save/create/rename/delete를 제공한다. 현재 대상과 전체 content hash를 확인하고 사용자 작업 receipt를 사용하며 원본·snapshot 읽기 경로는 유지한다. 삭제는 체크포인트의 원래 bytes 포함을 확인한 뒤 수행한다. 정확한 HTTP/type 계약은 [API 계약](../API-Contract.md)·`packages/contracts/src/workbench.ts`, 구현 상태는 C-144와 [활성 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)을 따른다. 편집 UI·dirty 복구·Monaco view의 승인 계약은 같은 CR의 P05–06, 구현 상태는 C-145·146으로 추적한다. 문서당 단일 모델은 화면 밖에서 유지하고 저장·닫기·복구는 명시적으로 수행한다. mixed/CR 줄바꿈은 원문을 보존한 상태에서 사용자가 LF/CRLF 변환을 선택한 뒤 편집한다. 구현·화면 검증 여부는 backlog와 실행 기록에서 확인한다.


## 사용자 터미널

[CR-046 P07–08](../change-requests/CR-046-development-workbench.md)의 터미널은 관리 사본에서 모델 연결 없이 실행하는 사용자 PTY다. 기존 명령 기록·Run 제어와 별도로 표시하며, 생성·입력 권한 인계·명시 종료와 불확실 상태 재확인을 제공한다. 화면/설정 이동은 detach이며 프로세스를 종료하지 않는다. 같은 사본의 파일 저장은 터미널 종료 확인 후 다시 가능하다.

xterm view와 parser는 화면 밖 store가 소유한다. 두 번째 renderer는 읽기 전용으로 연결하고 입력은 명시적으로 가져온다. 응답이 불확실한 stdin은 재전송하지 않는다. 출력 이력 상한을 넘어 새 화면 복구가 불가능하면 그 제한을 표시한다. Shift+Escape는 터미널 새로고침 버튼으로 포커스를 옮긴다. OSC clipboard/link와 title은 실행 경로로 사용하지 않는다. Linux 구현·실제 화면·번들 runtime 검증은 [P07–08 실행 기록](../evaluation/Development-Workbench-Terminal-2026-10-21.md), HTTP와 복구 한도는 [API 계약](../API-Contract.md)을 따른다.


## 패널 대상과 Run view 수명

[CR-046 P09](../change-requests/CR-046-development-workbench.md)는 현재 chat/graph/Run/files/review/preview의 대상 참조와 URL 변환을 `workbench/panels`로 모은다. 명시 Run/result 링크는 기억한 다른 대상과 섞지 않으며 설정 query는 view identity가 아니다. renderer의 서비스별 view key는 영속 layout ID를 대신하지 않는다.

Run 상세는 Run ID별 root store를 사용하고 그래프 편집기나 pane별 임시 store를 재사용하지 않는다. 같은 렌더 단계의 view 인계는 구독을 유지하며, 실제 마지막 view가 떠나면 구독을 해제한다. 명령 응답은 원래 Run에 보존하고 같은 Run 재진입에서 receipt/cache를 유지한다. 그래프·문서·PTY·SettingsLifecycle의 소유권은 기존 root에 남는다. 현재 배치와 URL을 유지한 구현·환경 검증은 [P09 기록](../evaluation/Development-Workbench-Panels-2026-10-21.md)을 따른다.

## 도킹 배치의 승인 계약

[CR-046 P10](../change-requests/CR-046-development-workbench.md)은 URL의 세션/Run 문맥 pane과 full WorkspaceTarget·path·viewId로 유지되는 문서 pane을 구분한다. workspaceId/project별 versioned layout은 배치 metadata만 저장하며, 잘못된 descriptor는 placeholder로, 손상된 grid는 유효한 문서 참조를 보존하는 기본 배치로 복구한다. 이동·preset·숨김은 문서 닫기나 프로세스 종료가 아니다. 명시 문서 닫기는 기존 저장/버리기/취소를 유지한다.

문서 최대 20개와 중앙 1~2 문서 그룹·보조 그룹·하단 도크를 기준으로 키보드 배치 조작과 390px의 한 활성 그룹, Run 승인·중지 접근을 제공한다. graph 전용 탭 통합은 P18이며 기존 graph/review 경로를 유지한다. C-150의 구현과 Linux 인앱·관련 회귀는 [P10 기록](../evaluation/Development-Workbench-Docking-2026-10-21.md)을 따른다. 실제 OS IME·스크린리더·설치판 GUI와 다른 OS의 검증은 별도다.
