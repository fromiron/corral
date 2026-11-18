# 공유 개발의 쓰기: 작업 계획

사람이 개발 서버와 미리보기를 켜 둔 채 에이전트가 같은 Paddock의 코드를 고칠 수 있게 한다. 지금은 task가 사본의 writer를 잡고 있으면 파일을 쓰는 실행이 `RUN_ALREADY_ACTIVE`로 거절되고, 공유 개발 모드는 사람이 손으로 켜야 하며 그 안에서도 에이전트의 쓰기·터미널·branch 작업·배포를 거절한다.

명세: [공유 개발 모드](../specs/workbench.md#공유-개발-모드)(이 계획의 중심), [개발 task와 Problems](../specs/workbench.md#개발-task와-problems), [사용자 터미널](../specs/workbench.md#사용자-터미널), [실행과 안전](../specs/execution-and-safety.md), [API 계약](../specs/api-contract.md)(작업 사본의 task · development · terminal · deployment 줄).

브랜치는 코드 단계(C)를 시작할 때 정한다. 코드와 테스트 돌리기는 세션 패널의 전체 E2E([세션 패널 계획](session-panel.md)의 S7)가 끝난 뒤에 한다. 단계마다 명세 → 실패하는 테스트 → 구현 순서이고, `pnpm lint`, `pnpm typecheck`, 관련 테스트를 돌린다. 계약 타입을 바꾸면 `pnpm contracts:check`도 돌린다.

| 단계 | 내용 | 상태 |
|---|---|---|
| A | 명세 | 썼다(`929f91e0`). 아래 "정하지 않은 것"이 남았다 |
| B | 빨간 반례 테스트 | 대기 |
| C | 서버 · core 코드 | 대기: 세션 패널의 전체 E2E 뒤 |
| D | 스튜디오의 거절 문구와 작업 탭 | 대기 |
| E | 미리보기 smoke가 초록 | 대기 |

## 사용자가 정한 것 (2026-11-18)

- **D1.** 공유 개발 중에는 파일을 쓰는 에이전트 실행을 거절하지 않고 받아들인다. 사람이 개발 서버와 미리보기를 켜 둔 채 에이전트가 코드를 고친다.
- **D2.** 공유 개발을 허용하는 곳(로컬 Desktop, `corral dev`)에서는 task(예: Run dev)를 시작하면 먼저 공유 개발이 켜진다. 마지막 task가 멈추고 쓰는 에이전트 실행이 없으면 저절로 끝난다. 사람이 모드를 손으로 켜지 않는다.
- **D3.** 가드를 새로 두지 않는다. 에이전트의 명령, 프로젝트 도구, 검사는 개발 서버 옆에서 따로 막지 않고 돈다. 사용자의 이유: 개발 서버를 켜고 브라우저로 디버깅하는 것도 아무것도 막지 않는다. 다시 불러오기가 바뀐 것을 그대로 받는다. 지금의 비교 후 교체 보호는 남는다: 문서 `baseHash`, 에이전트가 읽은 hash의 확인, Git HEAD/index 재확인, 사본 generation, 불확실 상태의 거절.
- **D4.** 공유 개발 중에는 모두 된다: 사람의 터미널, branch 생성/전환, pull, merge/rebase 시작/continue/abort, 배포.
- **그대로인 것.** 공유 개발을 허용하지 않는 서버는 단독 writer를 지킨다. 그곳의 거절 문구는 사본을 실제로 잡은 것(task, 공유 개발, 터미널)을 댄다. 지금의 `Refusal.busy`("지금 다른 실행이 진행 중입니다. … 대기열에 넣으세요.")는 task가 잡았을 때 틀리고, 실제 화면에는 대기열 단추도 없다.

## 코드에서 읽은 것

줄 번호는 `929f91e0`의 것이다. 조정자가 읽어 알린 것을 이 계획을 쓰며 다시 열어 보았다(마지막 하나는 위치를 찾지 못했다).

- **writer의 모양**: `workspace_access`가 사본마다 writer를 하나 둔다(부분 고유 색인 `workspace_access_writer`, `packages/storage-sqlite/src/workbench-migration.ts:23`). 공유 개발 중에는 공유하는 종류(`document.*`, `task`, `debug`, git의 stage · unstage · commit · fetch · push)를 비-writer로 접수한다: `apps/server/src/files/workbench-operations.ts`의 `sharedKinds`(32–46), `canShare`(87–94), `admit`(211–266).
- **실행의 writer**: `packages/core/src/coordinator.ts:2139`의 `writesFiles`가 허용 도구와 harness 자원으로 정적으로 정하고, `acquireRun`(`apps/server/src/files/service.ts:5932`)은 `admit` · `canShare`를 거치지 않는다.
- **`writer=0`인 실행은 고정 snapshot을 읽는 실행이다**: `readPinnedRun`(`service.ts:6096`). `commandContext`(`service.ts:5235`, 확인은 5256)와 `projectToolContext`(`service.ts:4442`)는 writer를 요구한다. 그래서 공유 개발 아래의 에이전트 writer를 `writer=0`으로 만들면 안 된다.
- **`finishDevelopment`는 실행 owner를 보지 않는다**: 사람 owner와 불확실 owner만 센다(`workbench-operations.ts:96–120`).
- **거절의 owner**: 오류의 구조화된 `owner`는 터미널뿐이다(`packages/contracts/src/errors.ts:40`, [API 계약](../specs/api-contract.md#3-오류)의 터미널 writer 충돌 문단). 거절 문구가 task나 공유 개발을 대려면 이것이 넓어져야 한다(아래 정하지 않은 것).
- **[마찰] 명령의 다시 계획**: 명령 계획은 tree를 고정하고(`commandPlanAt`, `service.ts:5317`, tree는 5354) 시작 직전에 다시 계획해 견준다(5411–5412). 공유 중에는 계획과 시작 사이에 사람이 저장하면 그 명령이 실패한다. 명세 단계에서 정한다.
- **[열림] 되돌리기**: 사본 전체를 기대한 tree와 견주어 되돌리고, writer가 사본을 잡고 있으면 거절한다(`withFileRestore`, `packages/core/src/coordinator.ts:963`). 그래서 공유가 켜져 있는 동안 계속 거절된다. 정하지 않았다.
- **[알려짐] 실행의 diff**: 실행의 변경(시작 tree와 끝 tree의 차이)에 그동안 사람이 저장한 것이 섞인다. 조정자가 알린 것이고, 위치는 아직 찾지 않았다.

## 정하지 않은 것

명세(`929f91e0`)에 넣지 않았다. 정하면 명세에 쓰고 이 목록에서 지운다.

- 명령의 다시 계획과 되돌리기(위의 마찰과 열림).
- task를 시작할 때 실행이나 터미널이 이미 단독 writer를 잡고 있으면: 지금은 409 `RUN_ALREADY_ACTIVE`이고 명세의 task 줄도 그렇다. 빨간 smoke(실행 쪽이 거절됨)를 뒤집은 경우다.
- 마지막 task가 멈췄는데 공유 중에 연 터미널 · 디버깅 · 배포가 살아 있으면: 명세는 "다른 사람 owner의 종료가 정리돼야 끝난다"는 지금의 규칙을 남겼으므로 공유가 이어진다. 그것으로 되는지.
- 공유 중에 한 사본의 터미널이 여럿일 수 있는가(단독 쓰기에서는 하나).
- `POST /sessions/:id/worktree/development`가 남는가, 남으면 그 operation ID는 누가 만드는가. 사람이 손으로 끄는 길이 있는가.
- 오류의 `owner`에 `task`와 `development`를 더하는 계약 바꿈(위 거절의 owner). 다른 실행이 잡았을 때 대기열 안내를 남기는가.
- 배포: 공유 중에는 검토한 뒤에도 파일이 바뀔 수 있다. 시작할 때의 소스 재확인은 남긴다.
- D1과 어긋나 보이지만 고치지 않은 명세의 줄: `execution-and-safety.md`의 "같은 Paddock의 동시 writer는 허용하지 않는다"(ABS-06 문단), `product-contract.md`의 지원하지 않는 것 목록의 "같은 Paddock의 동시 writer", `desktop-contract.md`의 ABS-06(같은 worktree의 writer owner는 하나)과 쓰기 가능 service가 writer lease를 계속 잡는다는 9번. 공유 개발의 writer는 여전히 development 하나라고 읽으면 맞고, 아니면 고쳐야 한다.

## 단계

### A. 명세

`929f91e0`: [공유 개발 모드](../specs/workbench.md#공유-개발-모드)를 D1–D4대로 쓰고, 단독 쓰기에서만 맞는 줄(터미널, 새 요청 입력란의 터미널 안내, branch 전환, task, 실행의 writer, 배포 · development 종료 · task · 터미널 · PTY의 API 줄, 세션 패널의 도크 줄)에 그 범위를 적었다. 위의 정하지 않은 것을 정하면 끝난다.

### B. 빨간 반례 테스트

먼저 쓰고 실패를 확인한다.

- 공유 개발을 허용하지 않는 서버에서 task가 사본을 잡고 있으면 파일을 쓰는 실행은 여전히 거절되고, 거절은 task를 댄다.
- 사본 generation이 맞지 않으면 공유 중에도 거절된다.
- 공유 개발에 미확인 효과가 있으면 새 효과도 쓰는 실행도 접수되지 않는다.
- 쓰는 에이전트 실행이 살아 있으면 공유 개발이 끝나지 않는다(마지막 task가 멈춰도, 명시 종료도).
- 쓰는 중에 실행을 취소하면: 종료가 확인되면 공유가 끝날 수 있고, 확인되지 않으면 uncertain으로 남는다.
- host 재시작 뒤 공유는 uncertain이고 저절로 돌아오지 않는다.

### C. 서버 · core

- task 시작이 공유 개발을 먼저 켠다. 마지막 task가 멈추고 쓰는 실행이 없으면 저절로 끝낸다.
- 공유 중에는 파일을 쓰는 실행을 development 아래에서 접수한다. `writer=0`으로 만들지 않는다(위 코드에서 읽은 것).
- `finishDevelopment`가 쓰는 실행을 센다.
- 공유 중에 터미널, branch 생성/전환, pull, merge/rebase, 배포를 접수한다.
- 거절이 사본을 잡은 owner를 싣는다(계약 바꿈을 정한 뒤).

### D. 스튜디오

- 거절 문구가 사본을 잡은 것(다른 실행, task, 공유 개발, 터미널)을 댄다. `Refusal.busy`의 대기열 안내는 정한 대로.
- 작업 탭은 공유 개발이 켜져 있는지 보이고, 켜는 조작을 두지 않는다.

### E. 미리보기 smoke

`apps/desktop/scripts/preview-feedback-smoke.ts`(`4bc69ead`가 미리보기를 탭으로 여는 길에 맞춰 다시 씀)가 실행 시작에서 빨갛다: 미리보기의 개발 task가 사본의 writer를 잡고 있는 동안 가짜 실행이 `RUN_ALREADY_ACTIVE`로 거절된다. C가 들어오면 초록이어야 한다. 그때까지 `desktop-contract.md`의 ABS-04 줄은 덮이지 않은 것으로 친다.

## 다음

- A의 정하지 않은 것을 사용자에게 묻는다(조정자를 거쳐).
- 세션 패널의 전체 E2E가 끝나면 B를 쓰고 돌린다.
