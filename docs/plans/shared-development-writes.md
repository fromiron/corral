# 공유 개발의 쓰기: 작업 계획

사람이 개발 서버와 미리보기를 켜 둔 채 에이전트가 같은 Paddock의 코드를 고칠 수 있게 한다. 이 작업 전의 코드에서는 task가 사본의 writer를 잡고 있으면 파일을 쓰는 실행이 `RUN_ALREADY_ACTIVE`로 거절되었다. 공유 개발은 사람이 손으로 켜는 모드였고, 그 안에서도 에이전트의 쓰기 · 터미널 · branch 작업 · 배포는 거절되었다.

명세: [공유 개발 모드](../specs/workbench.md#공유-개발-모드)(이 계획의 중심), [개발 task와 Problems](../specs/workbench.md#개발-task와-problems), [사용자 터미널](../specs/workbench.md#사용자-터미널), [실행과 안전](../specs/execution-and-safety.md), [API 계약](../specs/api-contract.md)(작업 사본의 task · terminal · deployment 줄과 [오류](../specs/api-contract.md#3-오류)의 `owner`).

브랜치는 `feat/session-panel`이다(명세와 같은 브랜치). 단계마다 명세 → 실패하는 테스트 → 구현 순서이고, `pnpm lint`, `pnpm typecheck`, 관련 테스트를 돌린다. 계약 타입을 바꾸면 `pnpm contracts:check`도 돌린다. 개발 중이므로 없어진 데이터 · 형식은 옮기지 않고 지운다.

| 단계 | 내용 | 상태 |
|---|---|---|
| A | 명세 | 끝(`929f91e0`, `cb50f479`, `56cc32fd`) |
| B | 빨간 반례 테스트 | 끝(`32afc4fd`) |
| C | 서버 · core · 계약 코드 | 만들었다(`8a5ca0fd`, `5ca4db5a`, `649d611d`) |
| D | 스튜디오의 거절 문구와 작업 탭 | 만들었다(`3e31e69b`, `7537a526`, `2eceb0a7`, `dd084916`, `0d6a9022`) |
| E | 미리보기 smoke가 초록 | 만들었다(`9218ee7a`) |

## 사용자가 정한 것 (2026-11-18)

- **D1.** 공유 개발에서는 파일을 쓰는 에이전트 실행을 거절하지 않고 받아들인다. 사람이 개발 서버와 미리보기를 켜 둔 채 에이전트가 코드를 고친다.
- **D2.** (D5가 대신한다) task를 시작하면 공유 개발이 켜지고 마지막 task가 멈추면 저절로 끝난다.
- **D3.** 가드를 새로 두지 않는다. 에이전트의 명령, 프로젝트 도구, 검사는 개발 서버 옆에서 따로 막지 않고 돈다. 사용자의 이유: 개발 서버를 켜고 브라우저로 디버깅하는 것도 아무것도 막지 않는다. 다시 불러오기가 바뀐 것을 그대로 받는다. 지금의 비교 후 교체 보호는 남는다: 문서 `baseHash`, 에이전트가 읽은 hash의 확인, Git HEAD/index 재확인, 사본 generation, 불확실 상태의 거절.
- **D4.** 공유 개발에서는 모두 된다: 사람의 터미널, branch 생성/전환, pull, merge/rebase 시작/continue/abort, 배포.
- **D5** (D2를 대신한다). 로컬 Desktop과 `corral dev`에서는 사본을 늘 공유한다. 켜고 끄는 것이 없다: 에이전트 실행, task, 디버깅, 터미널, Git 작업, 배포가 나란히 돈다. 단독 writer는 공유를 허용하지 않는 서버에만 남는다. 사용자의 이유: 다시 불러오기를 막는 것이 없어야 하고, 평소 작업 중에 브라우저로 시험할 수 있어야 사용자와 개발자에게 더 낫다.
- **D6.** 공유에서는 지금의 막음 셋이 없어진다.
  - 계획과 시작 사이에 사람이 저장했다고 명령이 실패하지 않는다. 명령의 시작 identity에 tree가 들지 않는다.
  - 쓰는 에이전트 실행이 사람의 검사를 막지 않는다. 검사는 그 순간의 사본 snapshot을 검사한다.
  - 체크포인트 복원은 쓰는 에이전트 실행이 없으면 된다. 지금의 기대한 tree 확인, 바뀌는 파일 목록, "복원 전" 체크포인트는 그대로다.
- **그대로인 것.** 공유를 허용하지 않는 서버는 단독 writer를 지킨다. 그곳의 거절 문구는 사본을 실제로 잡은 것을 댄다. 지금의 `Refusal.busy`("지금 다른 실행이 진행 중입니다. … 대기열에 넣으세요.")는 task가 잡았을 때 틀리고, 실제 화면에는 대기열 단추도 없다.

## 조정자가 정한 것 (2026-11-18)

1. 터미널, branch 작업, pull, merge/rebase, 배포는 나란히 돈다. 종료를 확인하지 못한 효과는 정리될 때까지 새 효과의 접수를 막는다. 명세에서 범위를 적은 줄들(터미널, 입력란의 터미널 안내, branch 전환, task, 실행의 writer, 배포 · 터미널 · PTY의 API 줄, 세션 패널의 도크 줄)은 그대로 둔다.
2. 로컬 host에는 development 모드가 남지 않는다. 켜는 조작, 종료 줄, 명시 종료는 명세에서 지운다(옮기지 않는다). 다시 시작하거나 종료를 확인하지 못한 뒤에는 owner마다 지금의 정리 길로 푼다: task는 멈추고 정리, 터미널은 그 제어.
3. task 시작의 거울 경우(실행이 먼저 사본을 잡고 있을 때)는 D5로 없어진다. 단독 writer 문단은 공유를 허용하지 않는 서버에만 걸린다.
4. branch 전환의 추적 변경 거절은 남긴다. Git의 거절처럼 커밋하지 않은 작업을 지키는 것이지 공유와는 상관없다.
5. 검사는 시작할 때 찍은 고정 snapshot에서 돈다.
6. API 계약의 PTY 문단 첫 문장을 고친다.
7. 어긋나 보이던 줄(`execution-and-safety.md`의 ABS-06 줄, `product-contract.md`의 지원하지 않는 것, `desktop-contract.md`의 ABS-06과 9번)은 단독 writer를 공유하지 않는 서버로 좁히고 로컬은 공유 문단에 잇는다.
8. 거절의 owner: API 계약의 오류에 쓴다. 구조화된 `owner`는 다른 실행 · task · 터미널, 그리고 단독 writer를 잡은 그 밖의 사람 작업을 싣는다. 대기열 안내는 다른 실행이 잡았을 때만 한다(그 실행이 끝나면 대기 요청이 시작되므로). 코드와 계약은 C에서 바꾼다.
9. 공유에서 배포는 검토한 뒤 파일이 바뀔 수 있다. 시작할 때 소스를 다시 확인하는 것은 지금대로이고, 가드를 새로 두지 않는다.
10. 코드는 `feat/session-panel`에 둔다.

## 코드에서 읽은 것

줄 번호는 `929f91e0`의 것이다. 조정자가 읽어 알린 것을 이 계획을 쓰며 다시 열어 보았다(실행의 diff만 위치를 찾지 못했다).

- **writer의 모양**: `workspace_access`가 사본마다 writer를 하나 둔다(부분 고유 색인 `workspace_access_writer`, `packages/storage-sqlite/src/workbench-migration.ts:23`). development가 켜져 있으면 공유하는 종류(`document.*`, `task`, `debug`, git의 stage · unstage · commit · fetch · push)를 비-writer로 접수한다: `apps/server/src/files/workbench-operations.ts`의 `sharedKinds`(32–46), `canShare`(87–94), `admit`(211–266). D5로 development 모드가 없어지므로 이 길은 늘 공유하는 모양으로 바뀐다.
- **실행의 writer**: `packages/core/src/coordinator.ts:2139`의 `writesFiles`가 허용 도구와 harness 자원으로 정적으로 정하고, `acquireRun`(`apps/server/src/files/service.ts:5932`)은 `admit` · `canShare`를 거치지 않는다.
- **`writer=0`인 실행은 고정 snapshot을 읽는 실행이다**: `readPinnedRun`(`service.ts:6096`). `commandContext`(`service.ts:5235`, 확인은 5256)와 `projectToolContext`(`service.ts:4442`)는 writer를 요구한다. 그래서 공유 아래의 에이전트 writer를 `writer=0`으로 만들면 안 된다.
- **`finishDevelopment`는 실행 owner를 보지 않는다**(`workbench-operations.ts:96–120`). D5로 이 종료 길은 없어진다.
- **거절의 owner**: 오류의 구조화된 `owner`는 지금 터미널뿐이다(`packages/contracts/src/errors.ts:40`). 명세는 `run` · `task` · `terminal` · `operation`(+`operationKind`)으로 넓혔다.
- **명령의 다시 계획**: 명령 계획은 tree를 고정하고(`commandPlanAt`, `service.ts:5317`, tree는 5354) 시작 직전에 다시 계획해 견준다(5411–5412). D6으로 공유에서는 tree를 견주지 않는다.
- **되돌리기**: 사본 전체를 기대한 tree와 견주어 되돌리고, 잡은 owner가 있으면 거절한다(`withFileRestore`, `packages/core/src/coordinator.ts:963`). D6으로 공유에서는 쓰는 에이전트 실행이 없으면 된다.
- **실행의 diff**: 실행의 변경(시작 tree와 끝 tree의 차이)에 그동안 사람이 저장한 것이 섞인다. 조정자가 알린 것이고 위치는 찾지 않았다.

## 알려진 것

- **실행의 diff**: 위와 같다. 공유에서는 실행의 변경에 사람이 그동안 저장한 것이 섞인다.
- **배포**: 공유에서는 검토한 뒤, 그리고 배포하는 동안 파일이 바뀔 수 있다. 시작할 때의 소스 재확인만 있고, 가드는 새로 두지 않는다(조정자 9).

## 정한 것: 화면이 아는 공유 여부 (조정자가 정함, 2026-11-18)

화면은 이 host가 사본을 공유하는지 알아야 한다. 입력란은 터미널이 살아 있으면 늘 `TerminalWriterNotice`를 보이는데(`apps/studio/src/workbench/session/composer/ComposerNotices.tsx:117`, `b753149d`), 공유하는 host에서는 그 경고가 틀리다. 사람의 효과가 거절될 것이라고 미리 말하는 다른 문구도 같다. 그래서 C나 D에서 읽기만 하는 host 능력 하나(이 host가 사본을 공유하는가)를 되살린다. development 상태의 route가 아니라 이미 있는 host나 능력을 읽는 곳에 둔다. 필드 이름은 만드는 이가 정하고, 계약을 쓸 때 API 계약에 적는다. C에서 `GET /health`의 `sharedDevelopment`(boolean)로 되살렸고(`5ca4db5a`, [API 계약](../specs/api-contract.md)의 `/health` 줄), 화면 쪽 일은 아래 D에 있다.

## 조정자가 정한 것: C를 만들며 (2026-11-18)

- 언어 제안의 적용과 `applyFileEdits`는 공유 사본에서 종료를 확인하지 못한 owner만 막는다. 쓰는 에이전트 실행은 막지 않는다([Workbench](../specs/workbench.md#공유-개발-모드), `56cc32fd`).
- 이미 있는 데이터베이스에 남은 `development` 행은 마이그레이션 0046 단계에서 지운다. 옮기지 않는다.
- 복원은 종료를 확인하지 못한 owner와, 잠깐, 끝나 가는(draining) 실행이 막는다. 둘 다 남긴다.
- 거절의 `owner` 모양은 [API 계약의 오류](../specs/api-contract.md#3-오류)에 쓴 대로 정해졌다.

## 단계

### A. 명세

끝. `929f91e0`(D1–D4)과 `cb50f479`(D5 · D6과 조정자가 정한 것). [공유 개발 모드](../specs/workbench.md#공유-개발-모드)가 로컬 host를 늘 공유로 쓰고, 단독 writer의 줄들은 공유를 허용하지 않는 서버로 좁혔다. development의 상태 · 시작 · 종료 줄은 지웠다. `56cc32fd`는 A가 놓친 줄(작업 탭의 내용과 주기 조회, 언어 제안의 적용, 디버깅)을 고쳤다. API 계약의 `/health`와 오류의 `owner`는 C의 `5ca4db5a`가 고쳤다.

### B. 빨간 반례 테스트

끝: `32afc4fd`. 서버 테스트 13개와 계약 테스트 2개가 각자 제 주장에서 빨갛게 실패했다(조정자가 알림). 공유하지 않는 서버에서 계획과 시작 사이에 사본이 바뀐 명령을 거절하는 것, 로컬 host에서도 연결 폴더는 명령을 한 번에 하나만 돌리는 것은 초록으로 남는 지킴이다.

로컬 host:

- task가 도는 동안 쓰는 에이전트 실행이 접수된다.
- 에이전트가 쓰는 동안 task 시작, 터미널, branch 전환이 각각 접수된다.
- 사본 generation이 맞지 않으면 여전히 거절된다.
- 종료를 확인하지 못한 owner는 정리될 때까지 새 효과를 막는다.
- 쓰는 중에 실행을 취소한다: 종료가 확인되면 다음 효과가 접수되고, 확인되지 않으면 그 owner가 정리될 때까지 막는다.
- host를 다시 시작하면 owner는 정리될 때까지 미확인으로 남는다.
- 계획과 시작 사이에 사람이 그 파일을 저장해도 명령이 돈다.
- 에이전트가 쓰는 동안의 검사는 시작할 때의 snapshot에서 돈다.
- 복원은 에이전트가 쓰는 동안 거절되고, 그 밖에는 되며, 기대한 tree 확인은 그대로다.

공유를 허용하지 않는 서버:

- task가 사본을 잡고 있으면 쓰는 에이전트 실행은 여전히 거절되고, 거절의 `owner`는 그 task다.

### C. 서버 · core · 계약

만들었다: `8a5ca0fd`(작업 사본 route가 거절의 제 코드를 지킨다는 빨간 테스트가 먼저), `5ca4db5a`. 담은 것(조정자가 알림):

- 공유 사본에는 writer가 여럿일 수 있다. 거절은 종료를 확인하지 못한 owner 때문일 때뿐이고, `owner`가 그것을 댄다.
- 공유를 허용하지 않는 서버의 단독 writer는 그대로이고, 이제 잡은 것을 댄다.
- D6의 막음 셋이 없어졌다(명령의 tree, 사람의 검사, 복원).
- 읽는 실행은 시작할 때 제 snapshot을 고정한다.
- 마이그레이션 0045 단계: `workspace_access_writer` 색인이 고유하지 않게 된다.
- `GET /health`의 `sharedDevelopment`.
- development 모드와 그 route, 계약, 클라이언트 호출, 스튜디오의 부분을 지웠다(옮기지 않는다).
- `workspaceFail`이 거절의 코드를 지킨다.
- 마이그레이션 0046 단계(`649d611d`): 이미 있는 데이터베이스에 남은 development 작업과 그것이 잡던 사본 접근을 지운다.

### D. 스튜디오

만들었다(조정자가 알림):

- `3e31e69b`: 빨간 테스트.
- `7537a526`: 거절의 종류를 사본을 잡은 것마다 나눈다. 대기열 안내는 실행이 잡았을 때만 한다. `StudioServices.sharedDevelopment`를 `/health`에서 읽고, 공유하는 host에서 `TerminalWriterNotice`는 종료를 확인하지 못한 터미널만 보인다.
- `2eceb0a7`: 진단이 `RefusalOwner`로 operation을 그 종류로 댄다. 미확인 줄들은 다시 보내라고 말한다.
- `dd084916`: 저장 거절의 빨간 테스트.
- `0d6a9022`: 저장 거절이 잡은 것을 댄다. 문서가 거절의 `writerOwner`를 지니고, `WriterHeld`는 저장을 말하는 한 줄과 그 잡은 것의 조작(task의 멈춤 단추나 터미널의 제어)만 보인다. 터미널 화면의 저장 대기 안내는 그 터미널에만 보인다.
- 작업 탭에서 공유 개발 모드를 켜고 끄는 조작과 그 상태 표시는 C의 `5ca4db5a`가 지웠다.

### E. 미리보기 smoke

만들었다: `9218ee7a`. `apps/desktop/scripts/preview-feedback-smoke.ts`는 `4bc69ead`가 미리보기를 세션 패널의 브라우저 탭으로 여는 길에 맞춰 다시 썼고, `9218ee7a`가 그 development 준비를 뺐다. 실제 앱에서 초록이다(조정자가 알림): 작업 탭에서 연 미리보기가 브라우저 탭으로 열리고, 주석을 달고, 미리보기 출처가 붙은 주석이 생기고, 개발 task가 계속 도는 동안 가짜 실행이 시작해 성공하고, 저장이 같은 살아 있는 미리보기를 바꾼다. 그래서 [Workbench](../specs/workbench.md#브라우저-주석)대로 살아 있는 서비스 미리보기에서 주석을 달아 보내는 것이 되고, `desktop-contract.md`의 ABS-04 줄은 다시 덮인다.

## 다음

- 모든 단계를 만들었다. 새 head에서 전체 검증이 돌고 있다.
- 이 계획은 Fable 검토(11월 19일 22:00 도쿄 뒤)까지 남는다.
