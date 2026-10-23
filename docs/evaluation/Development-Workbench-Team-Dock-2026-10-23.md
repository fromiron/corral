# CR-046 P18-A — 저장 팀 그래프의 도킹 탭

범위: CRL-WBD-014 / C-158 / TC-WBD-014-H,N,F. 저장 팀의 그래프 편집기를 세션 도킹의 독립 탭으로 연 구현의 검증 기록이다. 설치판·다른 OS·스크린리더를 포함하는 release gate가 아니다. 계약은 [CR-046](../change-requests/CR-046-development-workbench.md)의 P18 절을 따른다.

## 환경

- 기준 commit `1c1bdab`(P17) 위의 작업 트리. 이 기록은 그 위의 P18-A commit에 포함된다.
- Linux, Node 24.14.0, pnpm 10.30.3, Chromium(인앱 브라우저).
- 유료 모델·외부 호출은 쓰지 않았다.

## red 확인

구현 전에 새 시험 5건이 실패했다.

- `layout.test.ts`: `addGraphPanel`이 없고 graph descriptor가 복원되지 않음.
- `DockWorkbench.test.tsx`: `openGraph`가 없음.
- `editorDraft.test.ts`: `blocksLeaving`·`ownsSaveShortcut`·`subscribeEditorCopies`·`editorCopyDirty`가 없음.

## 결과

| 시험 | 결과 |
|---|---|
| Studio 단위 전체(vitest) | 58 파일 258건 통과 |
| `packages/react` locale 일치 | 3건 통과 |
| `tsc --noEmit`(studio) | 통과 |
| `pnpm spec:check` | 통과 |

- H: 같은 팀은 한 탭만 열리고 다시 열면 그 탭이 앞으로 온다. 그래프 탭은 세 preset 모두에서 문서와 같은 그룹에 놓이고 저장·복원 뒤 같은 descriptor다. 초안이 바뀌면 구독자가 불리고 dirty가 켜졌다가 undo로 꺼진다.
- N: 같은 팀의 두 번째 탭, 빈 ID, 문서 descriptor로 넣은 그래프, 다른 프로젝트의 그래프를 거절한다. 세션 안 편집기는 앱 안 이동을 막지 않는다. Ctrl+S는 그래프 안의 포커스에서만 팀을 저장한다. 그래프 탭 닫기는 문서 닫기 결정을 부르지 않는다.
- F: 저장 layout의 중복·다른 프로젝트 그래프는 그 pane만 안내로 바뀌고 다른 pane은 남는다.

## 인앱 확인

`node apps/server/src/main.ts --no-live --static apps/studio/dist`로 임시 workspace의 서버를 띄웠다. 인앱 브라우저(1280×800)에서 저장 팀을 지정한 세션을 열었다.

1. 세션 메뉴의 “팀 설계 열기”를 누르자 대화 옆 가운데 영역에 “Review team” 탭이 열렸다. 이름·revision(r1)·palette·canvas가 보였다.
2. 새로고침 뒤 저장된 배치(“사용자 배치”)로 같은 탭이 복원됐다.
3. 이름을 고치자 편집기에 “저장하지 않은 변경”, 탭에 `●`가 보였다. 변경 pane을 눌러 주소가 `?panel=changes`로 바뀌어도 확인창 없이 초안이 남았다.
4. 탭을 닫고 메뉴로 다시 열자 같은 미저장 이름과 revision r1이 그대로였다. 저장은 일어나지 않았다.
5. 좁은 탭에서는 편집기의 기존 container query가 palette·canvas·inspector를 세로로 쌓는다. 처음에는 문서용 고정(clip) 영역이라 아래가 잘렸고, 그래프 탭은 스크롤 영역으로 바꿔 고쳤다.

콘솔의 401 오류는 확인 중 서버를 여러 번 다시 띄우면서 이전 세션 쿠키로 보낸 요청에서 나왔다. 기능 오류로 보지 않았지만 원인을 하나씩 대조하지는 않았다. 시험 사본과 빈 사본 폴더는 확인 뒤 지웠다.

## 한계와 남은 일

- P18-B의 execution→활동·파일·결과·검사·검토 이동, host·attempt가 바뀐 뒤 늦은 Reins 명령의 반례는 이번 범위가 아니다. 과거 Run을 보는 동안의 제어 대상 표시는 기존 `DockRunControls`를 그대로 쓴다.
- 협업(동시 편집)·Loop·budget의 D&D 회귀는 이번 변경에서 새로 실행하지 않았다. 기존 단위 시험만 통과했다.
- 다른 OS·설치판·실제 스크린리더는 확인하지 않았다.
