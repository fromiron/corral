# 기능 명세: 준비 명령

- 상태: accepted
- 비목표: 검사 사본의 준비(등록 검사는 자기 고정 사본에서 돌며 준비하지 않는다), 평가가 만드는 사본의 준비, 저장소 파일에 적는 준비 명령, 세션마다 다른 준비 명령, 준비 프로세스의 격리, 준비 결과를 에이전트에게 알리기, 복사할 파일 목록의 선언, 셸 고르기, 브라우저 데모의 준비

준비 명령은 사람이 프로젝트마다 한 번 적는 셸 명령이다. Corral은 새 Paddock마다 그 명령을 한 번 돌려, 일을 시작하기 전에 사본이 쓸 수 있는 상태가 되게 한다. Git이 무시하는 파일(`node_modules`, `.env` 같은 것)은 새 사본에 없으므로, 의존성 설치와 그런 파일의 복사가 이 명령의 몫이다.

## 사용자 관측 동작

- **적기.** 프로젝트 폴더 설정의 검사 아래에 준비 명령 칸이 있다. 여러 줄의 셸 스크립트를 적고 저장한다. 칸의 예시 글이 `CORRAL_SOURCE_DIR`을 쓰는 법을 보인다.
  - 검사는 인자 목록이고 셸 없이 돈다. 준비 명령은 셸이 읽는 글이다.
  - 신뢰한 저장소에서만 저장한다. 준비 명령은 저장소 신뢰를 탄다. 따로 신뢰하는 것은 없다.
  - 비우고 저장하면 준비 명령이 없다.
- **언제 도는가.** 새로 만든 Paddock마다 한 번, 사본이 다 만들어진 뒤에 돈다.
  - 사본 만들기, 대화에서 갈라 만든 세션의 사본, [서브세션](sub-sessions.md#사용자-관측-동작)의 사본이 모두 같다. 갈라 만든 사본과 서브세션 사본은 받은 파일이 사본에 놓인 뒤, 곧 사본 준비가 끝난 뒤에 돈다.
  - 사본을 지우고 다시 만들면(copy generation이 오른다) 새 사본에서 다시 돈다.
  - 준비 명령이 없으면 아무것도 돌지 않고 아무것도 보이지 않는다. Paddock이 없는 세션에는 준비가 없다.
  - 사본 준비가 실패하면 준비는 돌지 않는다. 준비가 실패해도 사본 준비는 실패가 아니다. 사본과 그 브랜치는 남는다.
- **어디서 도는가.** 작업 폴더는 사본의 맨 위다. 셸은 에이전트 명령의 기본 셸이다: Linux와 macOS는 Bash, Windows는 Windows PowerShell이다. 그 셸이 없으면 준비는 돌지 않고 바로 실패로 끝난다.
- **환경.** 준비는 사람의 실제 홈 폴더와 그 설정으로 돈다. 패키지 관리자의 레지스트리 로그인, 패키지 캐시, Git 설정과 자격 증명 도우미를 도구가 늘 찾던 자리에서 찾는다.
  - 에이전트의 명령과 터미널은 지금처럼 쓰고 버리는 홈으로 돈다. 그래서 준비와 그 뒤의 명령은 도구의 설정과 캐시를 서로 다른 자리에서 찾을 수 있다.
  - Corral 자신의 비밀(모델 공급자 키, bootstrap 토큰, 그 밖의 서버 환경)은 준비에도 넘기지 않는다. 넘기는 것은 [계약](#계약)의 목록뿐이다.
- **무시되는 파일.** 준비는 프로젝트 원본 폴더의 위치를 환경 변수 `CORRAL_SOURCE_DIR`로 받는다. 필요한 파일은 명령이 거기서 스스로 복사한다(예: `cp "$CORRAL_SOURCE_DIR/.env" .env`). 서브세션에서도 이 값은 부모 Paddock이 아니라 프로젝트 원본 폴더다.
- **변경 검토.** 사본의 기준 tree는 준비 전에 고정된다. 그래서 준비가 쓴 파일 가운데 Git이 무시하지 않는 것은 대화의 변경으로 보인다. 실행 전에 돈 첫 준비의 변경은 [실행별 묶음](review-run-groups.md)의 "실행 밖"에 든다. 숨기지 않는다: 커밋하면 함께 실리는 실제 차이다.
- **기다리는 요청.** 준비가 도는 동안 준비는 그 사본의 [쓰는 에이전트 실행](../workbench.md#공유-개발-모드) 자리를 잡는다. 에이전트는 준비가 끝난 사본에서 일을 시작한다.
  - 준비는 이미 도는 실행을 멈추거나 기다리게 하지 않는다. 잡는 것은 그 뒤에 시작하는 쓰는 실행의 자리다.
  - 그 동안 입력창에서 보낸 요청(바로 보낸 [브라우저 주석](browser-annotate.md#바로-보내기)도 같은 길이다)은 Run을 만들지 않고 그 세션의 [대기 요청](composer-flow.md#대기-요청과-넘겨받기)이 된다. 입력창은 보냈을 때처럼 비고 거절은 보이지 않는다. 준비 중에 보낸 요청들은 보낸 순서대로 다른 대기 요청보다 앞에 선다.
  - 준비가 도는 동안 대기 요청의 "지금 시작"은 시작하지 않고 Paddock을 준비하는 중이라는 까닭을 보인다. 요청은 대기 줄에 그대로 있다.
  - 준비가 끝나면 대기열이 Run이 끝났을 때처럼 한 번 돈다. 준비가 성공했든, 실패했든, 중지됐든, 시간을 넘겼든 같다. 준비 중에 보낸 요청은 자동 시작이 꺼져 있어도 차례가 오면 시작한다. 그 밖의 대기 요청은 보통 규칙을 따른다.
  - 예약, 재개, 포크는 쓰는 실행이 있을 때처럼 거절되고, 거절은 준비를 사본을 잡은 작업으로 댄다.
  - 서버가 다시 시작한 뒤에는 대기열이 스스로 돌지 않는다([대화 입력 흐름](composer-flow.md#대기-요청과-넘겨받기)). 사람이 준비를 멈춰 끝내면 한 번 돈다.
- **중지와 다시 준비.** 사람은 도는 준비를 멈출 수 있다. 끝난 준비는 다시 돌릴 수 있고, 도는 동안에는 다시 돌릴 수 없다.
  - 다시 준비는 그때의 준비 명령을 돌린다. 이전 준비가 남긴 파일을 지우지 않는다.
  - 실행이 도는 동안 다시 준비하면 그 동안 바뀐 파일은 그 실행의 묶음에 든다([실행별 묶음](review-run-groups.md)의 구간 규칙).
- **고치기.** 도는 준비 중에 준비 명령을 고쳐도 그 준비는 시작한 글 그대로 돈다. 다음 준비가 새 글을 쓴다.
- **시간 한도.** 30분이다. 설정은 없다. 넘기면 준비를 멈추고 실패로 끝난다.
- **화면.** 상태는 Paddock이 이미 보이는 자리에만 있다: 변경 창의 Paddock 머리와 프로젝트 환경 탭의 Paddock 목록이다. 조작과 출력은 Paddock 머리에만 있고, 환경 탭의 목록은 상태 낱말만 보인다(목록을 연 때의 상태다).
  - 도는 동안: 상태 낱말 "준비 중"(Setting up)과 중지.
  - 성공하지 못하고 끝났으면(실패, 중지, 시간 초과): 상태 낱말 "준비 실패"(Setup failed)와 다시 준비. 상태를 누르면 남은 출력이 열린다.
  - 종료를 확인하지 못했으면 사람 작업의 결과 모름 상태로 보이고, 중지가 정리를 맡는다. 프로세스를 확인할 길이 없는 host(Linux 밖)에서 준비 중에 서버가 다시 시작하면 결과 모름이 아니라 "준비 실패"로 보인다.
  - 성공은 아무것도 보이지 않는다. 설명 줄은 두지 않는다.
- **출력.** 앞부분과 끝부분만 한정해 남긴다. 이 컴퓨터에만 있고, 실행 이벤트, 내보내기, 에이전트의 컨텍스트에 넣지 않는다. 에이전트는 준비의 결과를 듣지 않는다.

## 계약

- **저장.** 준비 명령은 프로젝트의 폴더 연결(binding)에 저장하는 1–32,000자 글이고 NUL이 없다. 없으면 준비 명령이 없다. 연결마다 준비 명령의 revision `setupRevision`(처음 0)이 있다.
  - 프로젝트 도구 구성(`ProjectToolConfig`)과 따로다. 저장해도 도구 구성의 revision이 오르지 않으므로 검사 · 배포의 launch fingerprint, 검토한 배포 계획, 언어 · 디버그 세션에 닿지 않는다.
  - 폴더 연결을 지우면 함께 지운다.
- **쓰기.** `PATCH /api/v1/projects/:projectId/workspace` 본문에 `setupCommand?: string | null`과 `setupRevision?: int`를 더한다.
  - `setupCommand`를 보내면 `setupRevision`(읽은 값)이 반드시 함께 온다. 지금 값과 다르면 409 `REVISION_CONFLICT`이고 아무것도 저장하지 않는다. 저장하면 1 오른다.
  - `null`은 준비 명령을 지운다. 공백만 있는 글은 `SCHEMA_INVALID`다.
  - 신뢰하지 않은 저장소는 403 `CAPABILITY_DENIED`다(검사와 같다).
  - 저장은 도는 준비에 닿지 않는다.
- **설정 읽기.** `GET /api/v1/projects/:projectId/workspace`의 `binding`은 `setupCommand`(없으면 null)와 `setupRevision`을 싣는다.
- **상태 읽기.** `GET /api/v1/sessions/:sessionId/worktree`의 `worktree`는 `setup`을 싣는다: 지금 copy generation에서 마지막으로 시작한 준비의 `{ operationId, state, reason, exitCode, startedAt, endedAt }`, 그런 준비가 없으면 null이다.
  - `GET /api/v1/sessions/:sessionId/worktree/setup/:operationId`는 그 준비의 target, 같은 요약, 남은 출력 `{ text, truncated }`를 돌려준다. 다른 세션의 operation은 404 `TARGET_NOT_FOUND`다.
  - 읽기는 준비를 시작하거나 다시 돌리지 않는다.
- **생명 주기.** 준비 하나는 사람 작업 receipt 하나다(`workbench_operations`, 종류 `setup`). [배포 작업](../workbench.md#배포-작업과-결과-확인)과 같은 원장, 같은 소유 프로세스 정리를 쓴다.
  - 상태는 `running`에서 `succeeded` · `failed` · `cancelled` · `uncertain` 가운데 하나로 끝난다.
  - `reason`: `command_failed`(0이 아닌 종료 코드), `command_timeout`, `launch_failed`(셸이 없음, host 프로세스 상한, 그 밖에 시작하지 못함), `stopped`, `trust_revoked`, `interrupted`(서버가 멈춘 동안 끝났음을 확인), `interrupted_unconfirmed`(프로세스를 확인할 길이 없는 host에서 서버가 다시 시작함).
  - target은 사본의 `WorkspaceTarget`(host, project, binding, session, copy generation)이다. receipt는 시작할 때 준비 명령 글의 hash를 고정한다.
  - 도는 준비는 사본의 owner다. 공유 개발 모드의 host에서는 task · 터미널 같은 다른 사람 작업과 나란히 돌고, 공유를 허용하지 않는 host에서는 사본의 writer를 잡는다([공유 개발 모드](../workbench.md#공유-개발-모드)). 어느 host에서든 도는 동안 그 사본의 쓰는 에이전트 실행 자리를 잡는다. 거절의 `owner`는 `{ kind: 'operation', operationKind: 'setup' }`이다.
- **자동 시작.** 새 사본을 만든 명령이 끝나면 서버가 준비를 시작한다. operation ID는 세션과 copy generation에서 정해진다. 그래서 같은 generation의 자동 준비는 한 번이다. 같은 서브세션 열기 명령을 다시 보내도 준비는 다시 돌지 않는다.
  - 준비 명령이 없으면 receipt를 만들지 않는다.
- **다시 준비.** `POST /api/v1/sessions/:sessionId/worktree/setup`, 본문 `{ operationId, target }`.
  - 같은 `operationId`와 본문은 처음 receipt를 돌려준다. 같은 ID에 다른 본문은 409 `REVISION_CONFLICT`다.
  - target의 copy generation이 지금 사본과 다르면 `REVISION_CONFLICT`, 사본이 없거나 준비 명령이 없으면 `TARGET_NOT_FOUND`, 신뢰하지 않은 저장소는 `CAPABILITY_DENIED`다.
  - 그 사본의 준비가 `running`이거나 `uncertain`이면 409 `RUN_ALREADY_ACTIVE`이고 `owner`는 그 준비다.
- **중지.** `POST /api/v1/sessions/:sessionId/worktree/setup/:operationId/stop`, 본문 `{ target }`.
  - process group을 끝내고 정리를 확인하면 `cancelled`(`stopped`)다. 확인하지 못하면 `uncertain`으로 남고 사본 예약을 풀지 않는다.
  - 이미 끝난 준비의 중지는 receipt를 그대로 돌려준다. target이 receipt와 다르면 `REVISION_CONFLICT`다.
- **시간 한도.** 30분, 고정이다. 넘기면 소유 프로세스 정리를 거쳐 `failed`(`command_timeout`)다.
- **기다리는 요청.** 지금 copy generation의 준비가 `running`인 동안, 세션 대기열은 그 준비를 끝나지 않은 Run처럼 본다.
  - 그 동안 그 세션의 시작(`POST /runs/auto`, `POST /runs`, 예약, 재개)은 Run을 만들지 않고 409 `RUN_ALREADY_ACTIVE`이며 `owner`는 그 준비다. `POST /runs/auto`는 팀을 고르는 모델 호출 전에 거절한다. 이 두 HTTP 시작의 거절은 아무것도 기록하지 않는다: 같은 `commandId`로 다시 보내도 같은 거절이고, 준비가 끝난 뒤에는 그 `commandId`로 시작할 수 있다. 예약과 재개는 실행 시작의 사본 관문에서 거절된다. 화면이 준비 상태를 미리 알 필요는 없다.
  - 입력창은 새 요청의 이 거절을 받으면 그 요청을 대기 요청으로 저장한다: `POST /sessions/:id/entries`에 `{ intent: 'queue', state: 'queued', start, afterSetup: true }`와, 다음 요청을 대기열에 넣을 때처럼 글 · 참조 · 첨부 · 이미지 · 권한 방식을 싣는다. 대기 요청의 명령 ID는 거절된 시작의 `commandId`다. 그래서 서버 대기열도 그 ID로 시작하고, 저장의 응답을 잃은 뒤 다시 보내도 대기 요청은 하나다([대화 입력 흐름](composer-flow.md#계약)의 재전송 규칙).
  - `afterSetup`은 새 대기 요청(`intent: 'queue'`, state `queued`)에만 실린다. 그 밖의 항목에 실으면 거절한다. 표시가 있는 항목은 만든 순서대로 표시가 없는 항목보다 앞에 놓인다. 대기열은 표시가 있는 맨 앞 항목을 [넘겨받은 요청](composer-flow.md#대기-요청과-넘겨받기)처럼 자동 시작 설정과 상관없이 시작한다.
  - 준비가 `running`이 아닌 상태로 끝나면 대기열이 한 번 돈다. 이전 generation의 준비가 끝나는 것은 대기열을 움직이지 않는다.
- **늦은 결과.** 준비의 결과는 그 receipt의 target에만 기록된다. receipt가 이미 끝났거나 copy generation이 지금 사본과 다르면 늦은 결과는 아무것도 바꾸지 않는다. 사본의 `setup`은 지금 generation의 준비만 보인다.
- **서버 재시작.** 재시작하면 `running`이던 준비의 명령을 다시 돌리지 않는다. 프로세스 identity가 남았는지에 따라 둘로 나뉜다. identity는 Linux에서만 남는다.
  - identity가 있으면 원장의 복구 규칙대로 `uncertain`이 된다. 그 identity로 process group이 사라졌음을 확인하면 상태를 읽을 때 `failed`(`interrupted`)로 정리한다. 확인하지 못하면 `uncertain`으로 남고, 중지가 정리를 확인할 때 끝난다. `uncertain`인 동안은 정리되지 않은 owner의 규칙([공유 개발 모드](../workbench.md#공유-개발-모드))대로 그 사본에 새 효과를 접수하지 않는다.
  - identity가 없으면 재시작할 때 확인 없이 `failed`(`interrupted_unconfirmed`)로 끝난다. 사본을 잡지 않고 host 프로세스 상한도 쓰지 않는다. 남은 프로세스가 있으면 그것이 사본에 계속 쓸 수 있고, 공유 개발 모드의 다른 사람 작업처럼 막지 않는다. [배포](../workbench.md#배포-작업과-결과-확인)는 이 규칙을 따르지 않는다.
  - 재시작한 서버는 대기열을 스스로 돌리지 않는다. identity로 정리를 확인해 사람의 중지가 준비를 끝내면 대기열이 한 번 돈다.
- **사본 지우기.** `running`이거나 `uncertain`인 준비는 사본을 잡은 owner다. [사본 삭제](../api-contract.md)와 세션 삭제는 그 동안 거절되고, 삭제 전 요약의 owner에 `setup`으로 보인다. 지우려면 먼저 준비를 멈춘다.
- **신뢰 해제.** 준비는 시작 바로 전에 저장소 신뢰를 다시 확인한다. 신뢰하지 않으면 시작하지 않는다: 다시 준비는 `CAPABILITY_DENIED`이고 자동 준비는 receipt를 만들지 않는다.
  - 도는 준비가 있는 동안 신뢰를 끄면 그 준비를 멈춘다. 정리를 확인하면 `cancelled`(`trust_revoked`)다.
  - 저장한 준비 명령은 신뢰를 꺼도 남는다.
- **환경 변수.** 넘기는 것은 이 목록뿐이다. 그 밖의 서버 환경은 넘기지 않는다.
  - 에이전트 명령(`commandEnvironment`, `apps/server/src/processes/shells.ts`)과 같은 것: host의 `PATH`와 Windows의 시스템 변수, `TEMP`, `TMP`, 그리고 `LANG=C.UTF-8`, `CI=1`, `GIT_TERMINAL_PROMPT=0`.
  - 사람의 실제 값: `HOME`, `USERPROFILE`, host에 있으면 `XDG_CONFIG_HOME` · `XDG_DATA_HOME` · `XDG_CACHE_HOME` · `XDG_STATE_HOME`, Windows의 `APPDATA` · `LOCALAPPDATA`, `SSH_AUTH_SOCK`.
  - 두지 않는 것: 에이전트 명령이 쓰고 버리는 홈에 맞춰 두는 `NPM_CONFIG_USERCONFIG`, `NPM_CONFIG_GLOBALCONFIG`, `GIT_CONFIG_NOSYSTEM`. 도구는 시스템과 홈의 기본 설정을 읽는다.
  - 더하는 것: `CORRAL_PROCESS_OWNER`(이 준비의 operation ID), `CORRAL_SOURCE_DIR`(프로젝트 원본 폴더의 절대 경로).
- **출력.** 명령 출력과 같은 한도와 가림으로 남긴다(`apps/server/src/files/check-output.ts`). receipt에 저장해 재시작 뒤에도 읽는다. 실행 이벤트, 세션과 기록의 내보내기, 모델 요청에 싣지 않는다. 세션이나 사본 receipt를 지우면 함께 지운다.

## 수용 시나리오

```gherkin
Scenario: 새 Paddock에 의존성을 설치한다
  Given 프로젝트의 준비 명령이 "pnpm install"이다
  When 사람이 사본을 만든다
  Then 준비가 사본의 맨 위에서 한 번 돌고 Paddock 머리에 "준비 중"이 보인다
  And 준비가 성공하면 상태는 아무것도 보이지 않는다
  And 사본의 node_modules가 있어 실행이 테스트를 바로 돌릴 수 있다

Scenario: Git이 무시하는 파일을 원본 폴더에서 가져온다
  Given 원본 폴더에만 Git이 무시하는 .env가 있다
  And 준비 명령이 "cp \"$CORRAL_SOURCE_DIR/.env\" .env"이다
  When 사람이 사본을 만든다
  Then 사본에 원본 폴더의 .env가 있다
  And .env는 Git이 무시하므로 대화의 변경에 보이지 않는다

Scenario: 준비가 쓴 추적 파일은 변경으로 보인다
  Given 준비 명령이 Git이 무시하지 않는 파일 하나를 고친다
  When 사본을 만들고 준비가 끝난다
  Then 대화 전체 범위의 변경 검토에 그 파일이 "실행 밖"에 있다

Scenario: 준비 명령이 없다
  Given 프로젝트에 준비 명령이 없다
  When 사람이 사본을 만든다
  Then 준비 receipt가 없고 worktree의 setup은 null이다
  And Paddock 머리와 환경 탭에 준비 상태가 보이지 않는다

Scenario: 준비 중에 보낸 요청은 기다렸다 시작한다
  Given 새 사본의 준비가 돌고 있다
  When 사람이 그 세션에서 요청을 보낸다
  Then 요청은 대기 줄에 서고 Run은 만들어지지 않는다
  When 준비가 성공으로 끝난다
  Then 서버가 그 요청을 한 번 시작한다
  And 세션의 자동 시작이 꺼져 있어도 같다

Scenario: 준비 중에 보낸 요청의 응답을 잃고 다시 보낸다
  Given 준비가 도는 동안 보낸 요청의 응답을 화면이 받지 못했다
  When 화면이 같은 commandId와 본문으로 다시 보낸다
  Then 같은 RUN_ALREADY_ACTIVE 거절이 돌아오고 화면이 저장한 대기 요청은 하나다

Scenario: 준비 중에 보낸 요청의 저장 응답을 잃고 다시 보낸다
  Given 준비 중에 보낸 요청이 대기 요청으로 저장됐지만 그 응답을 화면이 받지 못했다
  When 사람이 같은 글을 다시 보낸다
  Then 화면은 그 명령 ID의 대기 요청을 찾아 다시 저장하지 않고 입력창을 비운다
  And 대기 요청은 하나다

Scenario: 준비 중에 바로 보낸 주석도 기다린다
  Given 새 사본의 준비가 돌고 있다
  When 사람이 브라우저 주석을 바로 보낸다
  Then 주석 칸은 보냄으로 줄고 그 요청은 준비 중에 보낸 요청으로 대기 줄에 선다

Scenario: 준비 중에 예약 실행이 온다
  Given 새 사본의 준비가 돌고 있다
  When 그 세션의 예약 실행이 시작하려 한다
  Then RUN_ALREADY_ACTIVE로 거절되고 owner는 그 준비다

Scenario: 실행이 도는 동안 다시 준비한다
  Given 사본에서 쓰는 실행이 돌고 있다
  When 사람이 다시 준비를 누른다
  Then 준비가 실행과 나란히 돌고 실행은 멈추지 않는다
  And 준비가 도는 동안 새로 시작하는 쓰는 실행은 기다리거나 거절된다

Scenario: 준비 중에 보낸 요청이 먼저 선다
  Given 자동 시작이 꺼져 있고 대기 줄에 요청 Q가 있다
  And 새 사본의 준비가 돌고 있다
  When 사람이 요청 R을 보낸다
  Then 대기 줄은 R, Q 순서다
  When 준비가 끝난다
  Then R이 시작하고 Q는 사람이 시작할 때까지 남는다

Scenario: 준비가 실패해도 기다린 요청은 시작한다
  Given 준비 중에 보낸 요청이 대기 줄에 있다
  When 준비가 0이 아닌 종료 코드로 끝난다
  Then 서버가 그 요청을 시작한다
  And Paddock 머리에 "준비 실패"와 다시 준비가 보인다
  And 사본과 그 브랜치는 그대로다

Scenario: 셸이 없다
  Given 이 컴퓨터에 에이전트 명령의 기본 셸이 없다
  When 사본을 만든다
  Then 준비는 돌지 않고 failed(launch_failed)로 끝난다
  And 기다리던 요청은 시작한다

Scenario: 도는 준비를 멈춘다
  Given 준비가 돌고 있다
  When 사람이 중지를 누른다
  Then process group이 끝나고 정리를 확인한 뒤 준비는 cancelled(stopped)다
  And 기다리던 요청이 시작한다
  When 같은 중지를 다시 보낸다
  Then 같은 receipt가 돌아오고 아무것도 바뀌지 않는다

Scenario: 시간 한도를 넘는다
  Given 준비가 30분 넘게 끝나지 않는다
  Then 준비는 멈추고 failed(command_timeout)로 끝난다

Scenario: 다시 준비한다
  Given 사본의 준비가 실패로 끝났다
  When 사람이 다시 준비를 누른다
  Then 같은 사본에서 새 receipt로 준비가 다시 돈다
  When 그 준비가 도는 동안 다시 준비를 보낸다
  Then RUN_ALREADY_ACTIVE로 거절되고 owner는 그 준비다
  When 같은 operationId와 본문으로 다시 보낸다
  Then 처음 receipt가 돌아오고 준비는 하나다

Scenario: 도는 동안 준비 명령을 고친다
  Given 준비 명령 A로 준비가 돌고 있다
  When 사람이 준비 명령을 B로 저장한다
  Then 도는 준비는 A 그대로 끝까지 돈다
  And 다음 다시 준비는 B를 돌린다

Scenario: 준비 명령의 저장이 다른 저장과 겹친다
  Given 두 화면이 같은 setupRevision을 읽었다
  When 한 화면이 준비 명령을 저장하고 다른 화면이 읽은 revision으로 준비 명령을 저장한다
  Then 두 번째 저장은 REVISION_CONFLICT이고 첫 저장이 남는다

Scenario: 준비 명령의 저장은 검사에 닿지 않는다
  Given 검사 하나를 등록했고 그 검사의 실행 신뢰가 있다
  When 사람이 준비 명령을 저장한다
  Then 프로젝트 도구 구성의 revision과 그 검사의 launch fingerprint는 그대로다

Scenario: 서브세션은 받은 파일 뒤에 준비한다
  Given 부모 Paddock에 커밋하지 않은 변경이 있고 프로젝트에 준비 명령이 있다
  When 사람이 서브세션을 연다
  Then 부모의 파일이 서브세션 사본에 놓인 뒤 준비가 돈다
  And 준비의 CORRAL_SOURCE_DIR은 부모 Paddock이 아니라 프로젝트 원본 폴더다
  When 같은 열기 명령을 다시 보낸다
  Then 준비는 다시 돌지 않는다

Scenario: 이전 사본의 늦은 결과
  Given 사본 generation 1에서 시작한 준비의 결과가 generation 2의 사본이 생긴 뒤에 도착한다
  Then generation 2의 setup과 대기열은 바뀌지 않는다

Scenario: Linux 밖에서 준비 중에 서버가 다시 시작한다
  Given macOS에서 준비가 돌고 있고 대기 줄에 준비 중에 보낸 요청이 있다
  When 서버가 다시 시작한다
  Then 준비는 failed(interrupted_unconfirmed)이고 명령은 다시 돌지 않는다
  And Paddock 머리에 "준비 실패"와 다시 준비가 보인다
  And 그 사본은 새 실행을 받고, 사본과 세션을 지울 수 있다
  And 대기 요청은 스스로 시작하지 않는다

Scenario: Linux에서 준비 중에 서버가 다시 시작한다
  Given Linux에서 준비가 돌고 있고 대기 줄에 요청이 있다
  When 서버가 다시 시작한다
  Then 준비는 uncertain이고 명령은 다시 돌지 않는다
  And 그 사본은 새 효과를 접수하지 않고 대기 요청은 시작하지 않는다
  When 사람이 중지를 누르고 정리가 확인된다
  Then 준비는 cancelled이고 준비 중에 보낸 요청이 시작한다

Scenario: 준비 중에는 사본을 지울 수 없다
  Given 준비가 돌고 있다
  When 사람이 사본을 지운다
  Then 삭제는 거절되고 사본과 준비는 그대로다
  And 삭제 전 요약의 owner에 setup이 있다

Scenario: 준비 중에 신뢰를 끈다
  Given 준비가 돌고 있다
  When 사람이 저장소 신뢰를 끈다
  Then 준비는 멈추고 cancelled(trust_revoked)로 끝난다
  And 다시 준비는 CAPABILITY_DENIED로 거절된다
  And 저장한 준비 명령은 남는다
```

## 보안·성능·접근성

- 준비는 저장소의 코드를 이 컴퓨터에서 사람의 홈으로 돌린다(설치 스크립트 포함). 검사보다 넓은 자리다. 신뢰는 격리가 아니라는 저장소 신뢰의 안내가 이것도 덮는다.
- Corral의 비밀은 넘기지 않는다. 넘기는 환경은 정해진 목록뿐이다. 남는 출력은 자격 증명 꼴과 사본·원본 폴더·홈의 경로를 가린다.
- 원본 폴더의 경로는 준비 프로세스의 환경에만 있다. 응답, 실행 이벤트, 내보내기에 싣지 않는다.
- 준비는 host 공통 프로세스 상한을 하나 쓴다. 상한에 차 있으면 시작하지 못하고 실패로 끝나며, 기다리던 요청은 시작한다.
- 상태 낱말과 중지·다시 준비는 접근 이름을 가지며, 상태가 바뀌면 낭독기에 한 번 알린다. 출력은 고정폭 글로 열리고 스크롤할 수 있다.
