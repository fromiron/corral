# CR-046 P15 — 개발 task·preview·검사와 Problems

범위: CRL-WBD-011 / C-155 / TC-WBD-011-H,N,F. P13·P14의 인간 operation receipt와 공통 writer 규칙 위에 사람이 시작하는 개발 task를 더했다. 현재 계약은 [Workbench](../current/workbench.md), 변경 근거는 [CR-046](../change-requests/CR-046-development-workbench.md)의 P15 절을 따른다.

## 구현

- 계약: `TaskStart`, `TaskCandidates`, `UserTaskView`(`packages/contracts/src/workbench.ts`). client `tasks`·`startTask`·`taskOutput`·`stopTask`.
- host
  - `CommandRuntime`을 owner 타입으로 일반화하고 사용자 task 전용 runtime을 두었다.
  - 시작은 인간 operation `task`로 접수해 writer를 수명 동안 보유한다.
  - 계획은 별도 `workbench_tasks` 테이블을 예상했다. 기존 human operation 원장으로 receipt·재시작 정리가 충분해 테이블과 migration을 만들지 않았다.
  - 재시작 뒤 열린 receipt는 `uncertain`이다. 기록된 process group이 사라진 것을 확인하면 `cancelled`로 정리하고 writer를 돌려준다.
  - `verify()`는 사용자 task·터미널 writer를 이유로 거절하지 않는다.
  - preview의 대상 확인은 실행 중인 사용자 task를 받고, 연결 소유 증명은 task의 process group으로 한다.
- Studio
  - "Tasks & preview" 창에 `WorkbenchTasks`를 두었다. script별 실행·중지 아이콘 버튼의 접근성 이름은 "Run {script}"와 "Stop {script}"이고, 선택한 task의 출력은 `role=log`로 보인다.
  - Problems 창(`ProblemsPanel`, `problems.ts`)을 두었다. 행은 문서 store로 파일을 연 뒤 dock 문서 탭의 줄·열로 이동한다.
  - 저장 거절 표시 `WriterHeld`를 두었다. `RUN_ALREADY_ACTIVE` 거절을 "A running task or terminal is using this copy."로 보이고, 실행 중 task의 중지 버튼을 둔다.
  - ServicePreview는 실행 중인 task를 함께 나열한다. 창 목록의 `toolsHint` 설명은 없앴다.

## 검증 (Linux, Git 2.43.0, Node 24.22.1)

- 먼저 실패를 확인한 UI·store 시험(실패 확인 뒤 구현):
  - `WorkbenchTasks.test.tsx`, `ProblemsPanel.test.tsx`: 모듈이 없어 실패.
  - `store.test.ts`의 TC-WBD-011-N: `writerBusy`가 없어 실패.
  - `WriterHeld.test.tsx`: 모듈이 없어 실패.
  - 위 시험은 모두 PASS. `problems.test.ts` 2건도 PASS.
- server 시험 PASS. 이 기록으로는 구현 전에 실패했는지 확인하지 못했다.
  - `apps/server/test/user-tasks.test.ts` 3건: 후보 조회가 `prepare`를 실행하지 않음, 없는 script, 시작·출력, 자기 포트 증명과 다른 프로세스 포트 거절, 실행 중 저장 거절(`RUN_ALREADY_ACTIVE`)과 중지 뒤 저장, task 실행 중 검사, 재시작 뒤 process group 소멸 확인과 writer 반환.
  - `apps/server/test/user-tasks-routes.test.ts` 1건: HTTP 시작 → preview 생성(201) → 자격 없는 요청 403 → 위임 자격으로 task 응답 → 중지.
- 회귀
  - studio·react 단위 87파일 434건 PASS.
  - 관련 server 시험 16파일(documents·preview·terminal·user-git·workbench-operations·process-runtime·harness-api 등) 68건 PASS, 3건 skip.
  - studio·server `tsc --noEmit` 통과.
  - `e2e/layout.spec.ts` 25건 PASS(도구 창 이름 변경 반영).
- 실제 앱(server build, Playwright Chromium, 데스크톱 1280px·390px), 콘솔 오류는 의도한 409와 기존 404 2건뿐이었다:
  1. `typecheck` task의 tsc 형식 오류가 Problems에 나타났다.
  2. 행을 누르자 `src/a.ts` 문서 탭이 2행에서 열렸다.
  3. `serve` task를 시작하고 출력을 확인했다.
  4. 그 전에 연 문서의 저장이 거절되고 "Stop serve"가 보였다.
  5. 중지 뒤 다시 저장해 "Saved"가 됐다.
  6. 390px에서 두 창 모두 잘리지 않았다.

## 한계

- PTY에서 띄운 서버는 preview 대상이 아니다. 소유 process group을 증명할 수 없기 때문이다.
- task 출력은 이 host의 메모리 기록이다. 재시작 뒤에는 비어 있고 Problems의 task 결과에는 tree·stale 표시가 없다. stale은 검사 결과에만 있다.
- 등록 검사(`verifyCommands`)를 task 후보로 합치지 않았다. 검사는 기존 Checks 창에서 시작한다.
- 저장 거절 화면은 task만 멈출 수 있다. 터미널·Run은 각자의 창에서 멈춘다.
- preview 프레임은 desktop shell에서만 연다. task preview의 프록시 응답은 route 시험으로만 확인했고, 실제 앱에서 preview를 열어 보지는 않았다.
- Windows·macOS, 설치판, 실제 pnpm/yarn 프로젝트, 스크린리더는 검증하지 않았다.
