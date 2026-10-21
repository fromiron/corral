# 개발 Workbench P09: 패널 대상·경로와 Run 수명

- 기준: `3acdf11` 이후 이 기록을 포함한 변경. CR-046 / CRL-WBD-005 / C-149 / TC-WBD-005-H,N,F.
- 환경: Linux, Node24.19.0, pnpm10.30.3, 기존 React19.3.1/TanStack Router, production Studio와 실제 인앱 Chromium. 임시 Git/SQLite/서버와 ScriptedAgentAdapter만 사용했다.
- P09의 대상·경로 연결이며 Dockview·배치 저장·새 창은 P10의 후속 범위다. 라이브러리나 서버 API를 추가하지 않았다.

## 변경

`workbench/panels`에 chat/graph/Run/files/changes/artifacts/checks/review/file-preview/service-preview/terminal의 typed descriptor와 view key를 둔다. 현재 session panel renderer table, 그래프·Run·review·preview·terminal view가 이 key를 사용한다. services 또는 그 소유 store의 namespace로 다른 연결을 구분하고 실제 target만 key에 넣는다. 이 namespace는 renderer 수명용이며 영속 layout ID가 아니다. P10 저장 시 실제 host/project identity를 사용해야 한다.

session/Run/review/editor URL 검증과 session의 remembered selection 우선순위를 순수 함수로 옮겼다. 기존 URL·`tab=run` 호환과 패널 순서는 유지한다. 명시 target에는 기억된 다른 Run/execution/artifact/result를 섞지 않으며 설정 query를 panel identity로 사용하지 않는다. 설정 수명은 기존 RootLayout 소유이고 graph revision·draft, 문서 full target identity, preview origin/lease 의미는 그대로다.

RunPanel의 pane별 dedicated store와 RunDetail의 graph editor store 선택을 제거했다. 상세는 기존 `runFor(runId)`만 사용한다. 같은 React commit에서 마지막 view의 release→retain이 이어지면 microtask 종료 시점에 참조를 확인하여 기존 SSE/캐시를 유지한다. 실제 참조가 없으면 구독을 해제하며, 과거 Run의 SSE를 무한 유지하지 않는다.

동일 Run의 동시 open은 진행 중 읽기를 공유한다. dispose/다른 Run에는 기존 generation fence가 적용된다. 명령 receipt/error는 SSE generation 대신 원래 Run ID에 귀속하고 종료 시 정확한 pending command ID만 제거한다. 같은 Run 재진입은 receipt·artifact cache를 보존하고 definition/projection/stream을 다시 읽는다. 다른 Run으로 이동한 뒤의 늦은 응답은 현재 Run의 receipt/error를 바꾸지 않는다.

## 실패 재현

- Panel/route 모듈 미구현 상태를 red로 확인한 뒤 target 분리·기존 URL 변환 테스트 통과.
- Run 상세가 그래프의 임시 오류를 표시하던 SSR 반례에서, 해당 Run 소유 오류를 표시하도록 수정.
- 마지막 view 해제 직후 재부착에서 SSE·캐시·진행 중 취소 receipt가 끊기던 반례를 microtask handoff로 수정.
- 동일 Run을 두 view가 동시에 열면 definition 요청이 두 번 발생하던 반례를 in-flight open 공유로 수정. 실패/missing 후 명시 재시도와 다른 Run/dispose fence는 유지.
- 전체 route를 떠난 뒤 응답에서 pending ID가 남고, 복귀하면 receipt/cache가 지워지던 반례를 수정. Run A의 늦은 성공/실패가 B에 섞이지 않고 B의 진행 중 ID도 유지됨을 확인.

## 실행한 검사

| 검사 | 결과 |
|---|---|
| Panel/UI 경계·기존 draft/settings/navigation | 9파일24 PASS: registry/routes, RunPage.owner, navigation, editorDraft, sessionDraft, settingsTasks, FilePanel.polling, TerminalPanel |
| Run·채팅 소유 | 3파일33 PASS: run-session28, concurrent-run-sessions2, chat-run-read3. agent 최종 실행21:20:09, tool chunk72f20d/exit0. 별도 raw log는 저장하지 않음 |
| 문서/PTY/Reins 회귀 | 4파일33 PASS: documents/store, terminals/store, reins-panel, reins-controls |
| TypeScript·빌드 | 전체 pnpm typecheck와 Studio production build PASS. 기존 큰 chunk 경고 유지 |
| 문서 | spec:check 2438 checks, 316/316 tagged scenarios PASS |
| 형식 | 변경 TS/TSX 17파일 Biome exit0, 기존 non-null assertion 경고2개 유지. git diff --check PASS |

세 묶음은 서로 다른16파일/90사례다. `/tmp/corral-p09-ui.log`, `...-preservation.log`, `...-typecheck.log`, `...-build.log`에 root 검사 결과를 남겼다. 추가 E2E는 만들지 않았고, 비동기 반례는 Gate/microtask로 제어했다. 임의 대기시간을 성능 합격 조건으로 사용하지 않았다.

## 실제 화면

두 그래프·두 세션과 한 세션의 서로 다른 완료 Run 두 개를 REST/Coordinator 경로로 시드했다. fixture 자체도 결과 marker와 관리 사본 readback을 확인했고, bootstrap은 시드 후 새 서버에서 발급했다.

- 최신 결과를 기억한 뒤 과거 결과 링크를 열어 과거 Run ID·artifact·`P09_OLD_RESULT`가 표시되는 것을 확인했다. 대화 초안은 유지됐다.
- 과거 결과에서 일반→모델 설정→복귀 후 같은 결과·초안 유지. browser back은 최신 결과, forward는 과거 결과를 복원했다.
- 그래프 A의 이름을 미저장 상태로 바꾼 뒤 설정 왕복에서 이름·dirty 표시·undo 가용 상태를 확인했다. 그래프 B에는 별도 이름·노드·baseline이 표시됐다. 기존 native leave confirm은 관찰했지만 자동화에서 취소 선택의 결과를 독립 검증했다고 주장하지 않는다.
- hello.ts를 편집한 뒤 Run 패널로 이동/복귀해 같은 dirty 본문을 확인했다. 실제 Ctrl+Z/redo 후 명시 저장이 성공했다.
- 390×844에서 과거 Run 결과와 대화/작업 패널 전환에 접근했고 document width/scrollWidth 모두390이었다. 최종 브라우저 warn/error는0이었다.

화면 증거: `/tmp/corral-p09-old-result.png`, `/tmp/corral-p09-graph-draft.png`, `/tmp/corral-p09-run-390.png`, `/tmp/corral-p09-document-draft.png`. fixture 서버·소유 탭을 정리하고 viewport override도 해제했다. 실제 UI 결과와 Gate 기반 늦은 응답 테스트는 별개의 증거다.

## 한계와 다음 작업

Windows/macOS·실제 OS IME·스크린리더·패키지 GUI는 이번에 실행하지 않았다. native/dependency 경계를 바꾸지 않아 P07 패키지 smoke를 반복하지 않았으며, P07 성공을 P09의 새 패키지 증거로 주장하지 않는다. 실제 네트워크에 저장 응답 지연을 주입하는 추가 E2E는 하지 않았다. SettingsLifecycle의 늦은 완료는 기존 settingsTasks 회귀로 확인했다.

P10의 도킹·layout 복구·키보드 이동과 이후 Git/개발 여정은 남아 있다. 되돌림은 이 변경 커밋을 revert하면 되며 DB·파일·IndexedDB migration은 없다.
