# CR-046 P16 — Workbench Alpha 통합 인수

범위: CRL-WBD-012 / C-156 / TC-WBD-012-H,N,F. P13–P15(C-153–155) 위에서 개발 Workbench를 실제 앱에서 처음부터 끝까지 이어 본 기록이다. 설치판·다른 OS·외부 원격을 포함하는 release gate가 아니다. 현재 계약은 [Workbench](../current/workbench.md), 변경 근거는 [CR-046](../change-requests/CR-046-development-workbench.md)의 P16 절을 따른다.

## 환경과 방식

- **기준과 환경**
  - 기준 commit: `5e5d4bb`(P15). 이 기록은 그 위의 P16 commit에 포함된다.
  - Linux, Git 2.43.0, Node 24.22.1, pnpm 10.30.3, Playwright 1.64.1, Chromium.
- **앱 구성**
  - `pnpm build`로 만든 Studio를 `startCorralServer`가 제공한다(`apps/studio/e2e/server/harness.ts`).
  - 각 시험은 별도 workspace·SQLite·세션 사본 루트를 쓴다.
  - 브라우저는 로컬 서버 외의 host에 나가지 못한다.
- **실제로 쓴 것**
  - 임시 Git 저장소와 `git init --bare` 로컬 원격.
  - 실제 `node` task 프로세스와 loopback 포트.
  - 실제 preview proxy. Studio의 쿠키·CSRF로 lease와 위임 자격을 받는다.
- **mock**
  - agent는 `ScriptedAgentAdapter`의 결정적 응답이다. 파일은 broker의 `write_file`로 쓴다.
  - 유료 모델·외부 검색·외부 push는 없다.
- 시험 파일: `apps/studio/e2e/server/alpha.spec.ts`.
- 실행 명령:
  ```
  pnpm build
  cd apps/studio
  pnpm exec playwright test -c <로컬 설정> e2e/server/alpha.spec.ts --project=server
  ```

## 결과

`alpha.spec.ts` 3건 PASS(24초).

### TC-WBD-012-H — 모델 없이

1. 신뢰한 원본 폴더를 연결하고 검사를 등록한 뒤 세션 사본을 만들었다.
2. Files에서 `app.js`를 문서 탭으로 열어 고치고 저장했다. 사본 파일이 바뀌었다.
3. "Tasks & preview"에서 `serve`를 시작해 출력의 포트를 확인했다.
4. 그 task로 preview lease를 만들고(201), 위임 자격으로 프록시 응답("hello from alpha")을 받았다. 그다음 task를 중지했다.
5. Checks에서 등록 검사를 실행해 Pass를 확인했다.
6. Git 창에서 unstaged 변경의 diff를 보고, 선택 stage → commit → 새 branch `feature/alpha` → Push를 했다. 원격의 commit 작성자는 저장소 Git 설정의 `Alpha Person <alpha@example.test>`였다.
7. 원본 폴더의 HEAD와 `git status`는 처음과 같았다. 콘솔 오류는 0건이다.

### TC-WBD-012-H — 결정적 agent 요청 1회

1. 파일 도구가 있는 팀으로 "Write the notes"를 보냈다. 실행이 Succeeded가 되고 사본에 `notes/writer.md`가 생겼다.
2. 사람이 Git 창에서 그 파일을 stage → commit → `feature/notes`로 push했다. 원격 commit에는 그 파일만 들어 있었다.
3. 원본 폴더는 변하지 않았다. 콘솔 오류는 0건이다.

### TC-WBD-012-N / F — 반례

- **실패한 검사:** tsc 형식의 위치 `src/a.ts:2:19`가 Problems에 나왔고, 행을 누르면 문서 탭이 열렸다. 파일을 고쳐 저장한 뒤 그 결과는 "Outdated"로 표시됐다.
- **디스크 충돌:** 초안이 열린 채로 사본 파일이 밖에서 바뀌면 저장 시 "The file changed on disk."가 보였고, 디스크 내용을 덮어쓰지 않았다. "디스크 버전 사용"을 고르면 저장 실패 안내도 사라진다.
- **설정 대화상자:** commit 메시지를 쓴 채로 설정 대화상자를 열고 닫아도 메시지가 그대로였다.
- **잘못된 branch 이름:** `bad..name`은 "not a valid branch name"으로 거절됐고 ref는 만들어지지 않았다.
- **응답 유실(F):** 브라우저 route가 host 처리 뒤 commit 응답을 끊었다. 화면은 "결과 미확인"을 보였다. reload 뒤 같은 operation ID로 receipt를 읽어 정리했고, POST는 1회뿐이며 commit도 1개만 생겼다.
- 원본 폴더의 HEAD와 상태는 처음과 같았다.

## 이번 단계에서 찾아 고친 것

- 사본이 없는 세션에서 `GET …/worktree/tasks`가 404를 냈다. Tasks 창·preview 선택이 사본 전에 이를 조회해 콘솔 오류가 났다(P15 회귀). 이제 빈 후보를 돌려준다. `user-tasks.test.ts`에 실패를 먼저 확인한 시험을 더했다.
- 디스크 충돌을 "디스크 버전 사용"/"내 초안 유지"로 해결한 뒤에도 "The document could not be saved…" 안내가 남았다. 해결에 성공하면 지운다. 수정 전 build에서 위 반례 시험이 실패하고, 수정 뒤 통과하는 것을 확인했다.

## 회귀

- studio·react 단위 87파일 434건 PASS. studio `tsc --noEmit` 통과.
- server `user-tasks`·`user-tasks-routes` 5건 PASS.
- server E2E `files`·`file-preview`·`review` PASS. `service-preview`(TC-ABS-004-H)는 그 시험의 기존 조건으로 skip됐다.
- `pnpm spec:check`, `pnpm contracts:check` 통과.

## 검증하지 않은 것

- 터미널 연결 유실 반례는 이 시험에 넣지 않았다. PTY 재연결은 [C-147·148 기록](Development-Workbench-Terminal-2026-10-21.md)의 범위다.
- preview는 desktop shell의 프레임이 아니라 같은 proxy를 API로 열어 확인했다.
- 실제 외부 원격·credential helper·SSH, 서명 commit, Windows·macOS, 설치판 GUI, 실제 OS IME, 스크린리더.
- 시험 설정의 `git push`가 이 환경의 Git에서 "push negotiation failed" 경고를 냈다. 경고만 났고 push는 성공했다. 원인은 확인하지 않았다.
