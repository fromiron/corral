# 개발 Workbench P10: 도킹·배치·키보드·복원

- 기준: `e38e3a7` 이후 이 기록을 포함한 변경. CR-046 / CRL-WBD-006 / C-150 / TC-WBD-006-H,N,F.
- 환경: Linux, Node24.19.0, pnpm10.30.3, React19.3.1, Dockview8.6.1, production Studio와 실제 인앱 Chromium. 임시 Git/SQLite/서버와 ScriptedAgentAdapter를 사용했다.
- 최종 화면 후보: Studio `index-CsEiYIcx.js`. 새 서버에서 해당 빌드를 읽었으며 이전 서버의 캐시된 index로 새 빌드를 검증했다고 처리하지 않았다.

## 변경과 경계

세션 화면에 중앙 문서 그룹 최대 두 개, 보조 그룹, 하단 검사/터미널/명령·preview 도크를 연결했다. 대화·구현·검토 preset, 분할·그룹 이동·크기 조절·닫기와 키보드 조작 경로를 제공한다. 복원 또는 사용자가 조정한 배치는 특정 preset으로 오인하지 않도록 사용자 배치로 표시한다. floating·독립 창·graph 전용 도크는 추가하지 않았다. 기존 graph/review 경로를 유지하며 그래프 탐색 연결 완성은 P18이다.

URL은 현재 세션과 선택 Run의 주인이다. 문서는 host/project/binding/session/generation/path와 별도 viewId를 보존한다. 다른 세션의 문서는 현재 composer에 줄 참조를 넣지 못하고 원래 대화 링크를 제공한다. target 재확인 중에도 줄 참조는 차단한다. 문서 본문·undo·저장 receipt는 기존 root document store, PTY는 terminal store, Run은 기존 runFor/retainRun 경로가 소유한다. 활성 Run 제어는 선택된 과거 Run과 분리해 도크 밖에 둔다.

workspace identity/project별 versioned layout에는 배치와 검증된 참조만 저장한다. body/token/terminal output/임의 renderer params를 복사하지 않는다. 알려지지 않은 pane·다른 scope·중복 owner 참조는 placeholder로 격리하고 손상된 grid는 유효한 문서 참조를 유지한 기본 배치로 복구한다. 안정된 host identity가 없으면 layout을 영속화하지 않는다.

preset은 모든 열린 ID를 유지하고 `reuseExistingPanels`와 `renderer: always`로 기존 뷰를 이동한다. 배치 이벤트는 문서 닫기나 PTY 종료가 아니다. 문서는 기존 closeView의 저장/버리기/취소 결과가 허용해야 닫히고, 서로 다른 viewId의 두 편집기는 모델/undo를 공유한다. PTY 패널은 세션당 하나이며 닫기·재열기는 detach/attach, 종료는 기존 명시 Stop이다. terminal 선택 ID만 host/project/session별로 기억한다. preview의 기존 명시 unmount 정리 의미는 유지한다.

`dockview-react@8.6.1` 하나를 직접 추가했다. 하위 dockview/core도8.6.1이며 MIT 고지와 dependency metadata를 등록했다. Context7이 제공되지 않아 공식 문서와 정확한 설치 버전의 타입/배포 코드를 대조했다. 라이선스·의존성 근거는 [고지](../../THIRD-PARTY-NOTICES/dockview.md)를 참조한다. Enterprise 기능은 사용하지 않는다.

## 실패 재현과 수정

- 도킹/문서/활성 Run 연결의 미구현 red를 확인한 뒤 기존 owner 경로로 구현했다.
- 21번째 문서의 기존 탭 퇴출, 같은 ID의 다른 대상, 오래된 generation, 늦은 저장 뒤 새 입력 등 기존/신규 반례를 사용했다. 단순 tab unmount로 문서를 폐기하지 않는다.
- 마지막 중앙 context 탭을 닫은 뒤 문서를 열면 보조 그룹에 들어가던 실제 Dockview 반례를 중앙 그룹 재생성으로 수정했다.
- leaf root·배열 orientation·누락 size는 공개 타입보다 실제 deserializer가 엄격했다. 설치된 Dockview에서 누락 size가 NaN 너비를 만드는 것을 재현하고 안전한 fallback을 확인했다. 중복 terminal context와 같은 문서/viewId도 격리했다.
- 실제 터미널에 포커스하면 always-rendered overlay가 도크 밖의 scrollHeight를 늘려 상단 제어를 밀어냈다. `.corral-dock-area`의 overflow를 제한한 후 outlet의 clientHeight/scrollHeight가 같고 scrollTop이0인 상태를 실제 입력 뒤 확인했다. 전역 outlet 동작은 바꾸지 않았다.

## 실행한 검사

| 검사 | 결과 |
|---|---|
| 관련 회귀 | 22파일112 PASS. 이후 활성 문서 재시작 복원 사례1개를 추가한 최종 host/document/FilePanel 3파일9 PASS. 중복을 제외한 합계22파일113사례 |
| 포함 범위 | docking layout/host, DockDocumentPanel, DockRunControls, FilePanel docking/polling/기존 helper, TerminalPanel, document/terminal stores, panel registry/routes, navigation/editorDraft/sessionDraft/settingsTasks, RunPage.owner, Run session/concurrent/chat/Reins |
| 타입 | 전체 `pnpm typecheck` PASS |
| production build | Studio PASS. 기존 큰 chunk 경고 유지. 최종 main chunk2,336.89kB/gzip666.70kB는 전체 앱 chunk이며 Dockview 단독 크기가 아님 |
| 형식 | 변경 코드/설정19파일 Biome PASS, diff 검사 PASS |
| 추적·계약·의존성 | spec:check2459 checks·319/319 tags, contracts:check, deps:check PASS |

로그: `/tmp/corral-p10-regression.log`, `...-final-ui.log`, `...-typecheck-all.log`, `...-build-final.log`, `...-biome.log`, `/tmp/corral-p10-final-{spec,contracts,deps}.log`. 새 E2E는 추가하지 않았다. 새 동작의 의미 있는 상태·실패 사례와 기존 회귀를 사용했고 작은 지연을 성능 합격 기준으로 삼지 않았다.

## 실제 인앱 화면

- 실제 파일 목록에서 문서20개를 열고 21번째는 기존 문서를 제거하지 않은 채 안내를 표시했다. 구현/검토 preset 뒤에도 열린 문서와 dirty 표시가 유지됐다.
- clean 문서 하나를 닫고 dirty hello.ts를 분할했다. 두 뷰에서 같은 본문을 관찰했고 실제 Ctrl+Z/redo가 양쪽에 적용됐다. 키보드 Enter로 크기 조절·그룹 이동·닫기를 실행했다. 두 번째 뷰 닫기는 본문을 버리지 않았고 마지막 dirty 뷰는 확인 창에서 취소할 수 있었다.
- 새 renderer에서19개 열린 문서 참조와 사용자 배치를 복원하고 이전 초안을 명시적으로 복구했다. 복구 본문을 저장해 실제 파일 bytes를 읽어 확인했다. clean 상태의 실제 페이지 reload에서도19개 문서와 배치를 복원했다. 브라우저 이탈 보호가 있는 dirty reload 대신 새 renderer에서 복구를 확인했으며 reload 뒤 Monaco undo 복원을 주장하지 않는다.
- 다른 세션에서는 원래 대화 링크와 비활성 줄 참조를 확인했다. 원래 대화로 돌아온 뒤 저장했다.
- 390×844에서 폭/scrollWidth는 각각390, outlet 높이/scrollHeight는 각각792였다. 활성 그룹만 너비390을 가지며 다른 그룹은 너비 또는 높이가0이었다. 승인 대기 버튼으로 정확한 Run의 승인 화면을 열고 도크 밖 취소 확인으로 해당 Run을 취소했다.
- 세션 B에서 실제 PTY로 `P10_PTY_ALIVE`를 출력했다. 세션 A의 Run 취소 후에도 같은 PTY가 실행 중이었고 새 renderer에서 원래 출력과 명시 입력 권한 획득을 확인했다. `P10_AFTER_CANCEL` 입력, preset, 패널 닫기/재열기 뒤에도 원래 출력과 프로세스가 유지됐다. 명시 Stop 뒤 종료됨/종료 코드0을 확인했다.
- 과거 Run의 정확한 ID/결과 marker, 일반→모델 설정→닫기 뒤 같은 결과와19개 문서, browser back/forward에서 첫째/둘째 Run 선택을 확인했다.
- 라이트/시스템 다크 테마를 실제 화면에서 확인했다. 최종 warn/error는0이었다. 테마·viewport override를 복원하고 소유 탭/서버/임시 workspace를 정리했다.

화면 증거: `/tmp/corral-p10-docking-desktop.png`, `/tmp/corral-p10-docking-390.png`, `/tmp/corral-p10-terminal-preserved.png`, `/tmp/corral-p10-history-preserved.png`, `/tmp/corral-p10-docking-light.png`. 임시 fixture의 `--check`도 실제 Coordinator 승인 대기→승인→완료를 확인했다. 유료 모델·외부 push·배포·merge는 실행하지 않았다.

## 한계와 다음 작업

손상된 layout의 복구는 단위 검사와 설치된 Dockview의 실제 deserializer로 검증했으며 브라우저 저장소에 오류를 주입한 별도 E2E는 만들지 않았다. 실제 OS IME·스크린리더·Windows/macOS·설치판 GUI를 이번에 검증하지 않았다. native dependency를 바꾸지 않아 이전 PTY 패키지 smoke를 반복하지 않았으며 그것을 이번 후보의 새 패키지 증거로 주장하지 않는다.

P11 context chip과 이후 Git/개발 여정은 남아 있다. P22의 shared-development와 P30 외부 harness 결정 조건은 그대로다. rollback은 이 변경 커밋을 revert하며 서버 DB migration이나 문서/PTY 원장 변경은 없다. layout preference를 무시해도 기존 초안 저장소는 지우지 않는다.
