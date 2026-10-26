# Corral — HTTP·이벤트·오류 계약

현재 타입·생성 schema의 위치는 [API 원본 안내](api.md)를 따른다. 아래 표는 기능별 계약을 설명하며 전체 endpoint 자동 생성 목록이 아니다. 변경할 경로는 `apps/server/src/app.ts`·기능별 routes·`packages/client`와 함께 확인한다.

## 1. 명령과 조회

주소는 로컬 same-origin `/api/v1` 기준이다. 인증 세션, workspace binding, Host/Origin 검사 후 처리한다. API key는 이 API의 응답에 포함하지 않는다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /corrals | cursor? | 정의 목록(각 `projectId` 포함); 본문·레이아웃은 필요 시 조회 |
| POST /corrals | 정의+레이아웃, `projectId?` | 새 저장 정의(프로젝트 없으면 기본 프로젝트). 없거나 보관한 프로젝트는 `TARGET_NOT_FOUND`. clone 시 ID 재발급 |
| GET /corrals/:id | — | definition/layout/revisions |
| PUT /corrals/:id | If-Match definition revision,definition | conflict 검사 후 저장; 실행 중 Run 원본에는 영향 없음 |
| POST /corrals/validate | 현재 draft definition | diagnostics + executable IR summary; side effect 없음 |
| POST /runs | commandId,corralId,definitionRevision,input,mode,startFrom?,sessionId?,conversation?,references? | runId+receipt; validation 완료 전 모델 호출 없음. `startFrom {runId, artifactVersionId}`는 그 버전 본문을 브리프 뒤에 붙이고 `run.started.startedFrom`에 남김. 없는 Run·다른 Run의 버전은 `TARGET_NOT_FOUND`, 산출물 크기 한도 초과는 `LIMIT_REACHED`. `conversation {throughRunId}`는 같은 세션의 끝난 Run까지의 요청·답을 Coordinator 기록에서 복사해 대화 차례로 보내고 `run.started.conversation`에 출처·hash를 남김. 세션 없음·없는 Run·다른 세션·끝나지 않은 Run은 `TARGET_NOT_FOUND`, 산출물 크기 한도를 넘는 오래된 차례는 빠지고 그 수를 기록. `references`(최대 20)는 file·folder·run·role을 포인터로 나열하고(권한 없음) result는 그 버전 본문을 복사. 없는 대상 `TARGET_NOT_FOUND`, 결과 합계 초과 `LIMIT_REACHED` |
| GET /runs/:id/snapshot | — | read model + snapshotSeq |
| GET /model-attempts | `ownerId?`, `runId?`, `sessionId?`, `before?`, `limit?` (1–100; 기본 50) | `{items,nextCursor}`. 물리 시도·nullable usage·subscription/unknown 가격 상태. private/no-store. 본문·자격 증명 제외 |
| GET /runs/:id/events?after=N | cursor | commit된 domain events의 SSE; token frames 별도 type |
| POST /runs/:id/commands | `packages/contracts/generated/command.schema.json` | accepted receipt 또는 4xx; HTTP202는 적용 완료가 아님 |
| GET /runs/:id/commands/:commandId | — | command 상태·관련 events·적용 scope |
| GET /runs/:id/artifacts/:artifactId/versions/:version | — | 불변 본문·생성/읽기/지시/검토 경로 |
| GET /model-profiles | — | public profileId·지원 capability·keyConfigured, secret 없음 |
| POST /runs/:id/export | redaction policy | 공개용 bundle. 원문 비공개가 기본 |

구현 중 추가한 주소. 모두 같은 세션·Host/Origin 검사를 거친다. `health`와 `POST /session`만 세션 없이 받는다.

bootstrap 링크는 해당 서버 프로세스가 실행 중인 동안 다른 브라우저·프로필에서도 반복 사용할 수 있다. 유효한 세션 cookie가 있으면 같은 링크를 다시 교환해도 세션과 CSRF token을 유지한다. cookie가 없거나 유효하지 않으면 새 세션을 발급한다. 잘못된 token은 기존 세션이 있어도 거절하며, 서버 재시작은 이전 링크와 세션을 모두 무효화한다.

인증된 브라우저 프로필의 같은 호스트·포트에 접속하는 탭은 기존 세션 cookie를 공유한다. 새 탭·새로고침에 bootstrap 재교환을 요구하지 않는다. 같은 탭에서 bootstrap 링크의 fragment만 바뀌어도 인증 초기화를 다시 실행한다. cookie 이름은 실제 수신 포트를 포함해 같은 호스트의 다른 Corral 서버가 인증을 덮어쓰지 않게 한다. 다른 서버의 세션과 CSRF token은 받지 않는다. cookie 이름 분리는 포트 사이의 보안 격리를 뜻하지 않으며 기존 Host/Origin·CSRF 검사를 유지한다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /health | — | `ok`, schemaVersion, version, backendSessionId, agents(`mock`). secret 없음 |
| POST /session | `{token}` | 서버 실행 중 유효한 bootstrap token을 교환해 HttpOnly·SameSite=Strict 세션 cookie. 잘못된 token은 401 |
| GET /session | — | 세션 cookie가 유효하면 `{ok:true,csrfToken}`. 모든 변경 요청은 `x-corral-csrf` 헤더로 이 값을 보낸다 |
| GET /runs | — | 실행 이력(최신 먼저): runId, status, corralId, startedAt, projectId(시작할 때의 프로젝트), sessionId. `POST /runs`는 `sessionId?`를 받고 팀 프로젝트의 세션이 아니면 `TARGET_NOT_FOUND` |
| GET /model-catalog | — | 내장 provider·엔드포인트와 모델 목록. 자격 증명·상태 없음 |
| GET /model-config | — | `modelProfiles`, `modelProviders`, `usingDefaults`, `revision`(설정 파일 내용 해시) |
| PUT /model-config | revision, modelProfiles, modelProviders | 두 키만 교체해 저장·즉시 반영. 검사 실패 `SCHEMA_INVALID`(필드 이름만), 다른 revision `REVISION_CONFLICT` |
| GET /runs/:id | — | RunSnapshot: 실행에 쓴 정의·definitionHash·출처 revision·criteriaVersionId·mode |
| GET /runs/:id/artifact-versions/:artifactVersionId | — | 불변 본문 `{text}`. 이 run의 산출물 버전과 기준 버전만 |
| GET /runs/:id/artifact-versions/:artifactVersionId/preview | — | 산출물 버전이 HTML 문서일 때만 `text/html` 본문. 응답 CSP `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:` 등, `frame-ancestors 'self'`. 그 밖에는 `TARGET_NOT_FOUND` |
| POST /corrals/:id/duplicate | `{name}` | 새 id의 사본(revision 1), 원본과 같은 프로젝트 |
| PUT /corrals/:id/project | `{projectId}` | 팀을 다른 프로젝트로 이동(revision 그대로). 지난 Run은 원래 프로젝트에 남음. 없거나 보관한 프로젝트는 `TARGET_NOT_FOUND` |
| GET /projects | — | 프로젝트 목록: 기본 프로젝트 먼저, 보관 포함(`archivedAt`) |
| GET /sessions?projectId= | — | 프로젝트의 작업 세션(고정 먼저, 최근 활동 순), 각 `entries` 포함 |
| POST /sessions | `{projectId, title, objective?, corralId?, autoTitle?, meeting?:MeetingConfig}` | 새 세션. `meeting`이 있으면 회의, 없으면 기존 work 세션이며 이후 종류 변환은 하지 않는다. 제목이 비면 목적 첫 줄. `autoTitle:true`는 표시용 임시 제목을 첫 저장된 next/queue 요청으로 한 번 확정하며 수동 제목 저장 시 해제한다. 기본 false로 기존 호출을 보존한다. |
| GET·PATCH /sessions/:id | `{title?, objective?, corralId?, auto?, pinned?, archived?, expectedRevision}` | 세션 읽기·수정(revision 검사). `corralId:null`은 auto이며 명시 팀 조회 실패와 구별한다. `auto`는 모델 프로필·추론 설정 |
| POST /sessions/:id/entries | `{intent, text, state, runId?, executionId?, detail?, auto?}` | 요청 기록 추가(본문은 이후 불변). `auto`에는 실행별 템플릿·선택 사유·모델·추론·대체 정보를 보존 |
| PATCH /sessions/:id/entries/:entryId | `{state, runId?, detail?, auto?}` | 기록 상태와 선택 결과 갱신(대기 → 시작 등) |
| GET /sessions/:id/meeting | — | `MeetingView`: 저장된 메시지·답·사용량·대기 메시지·회의록·결정. 내부 `rounds`는 기존 기록/실행 소유권을 위한 응답 묶음이며 UI의 진행 단계가 아니다. 새 레코드의 `order`로 메시지·발언 순서를 표현하며 `replyTo`는 에이전트 멘션의 실제 출처다. 조회·재열기는 모델을 호출하지 않는다 |
| POST /sessions/:id/meeting/rounds | `MeetingRoundRequest` | 사람의 대화 메시지를 즉시 게시한다. 진행 중 답변은 전송을 막지 않고 다음 발언부터 최신 사용자 메시지를 반영한다. 선택한 `TextAttachments`만 고정해 전달한다. 동일 명령·본문·대상·모드는 기존 응답 묶음, 내용 변경은 conflict. legacy 반론 명령/기록은 호환성을 유지하되 새 UI는 사용하지 않으며 횟수 상한도 요구하지 않는다 |
| POST /sessions/:id/meeting/rounds/:roundId/stop | — | 현재 응답 중인 메시지를 중지하면 진행 중·대기 중 발언과 멘션 응답을 함께 취소. 완료된 과거 메시지에 대한 늦은 중지 요청은 새 대화를 취소하지 않는다. 이미 확정한 답은 보존 |
| PATCH·DELETE /sessions/:id/meeting/queued | PATCH: `QueuedMeetingMessage` | 이전 버전에서 저장한 미전송 대기 초안 수정/삭제. 새 메시지는 이 슬롯을 사용하지 않는다. 수정은 현재 queued command ID를 확인 |
| POST /sessions/:id/meeting/queued/send | — | 진행 중 답변이 없을 때 저장된 대기 메시지를 명시 전송 |
| POST /sessions/:id/meeting/decisions | `MeetingAdoptDecisionRequest` | 회의록 후보를 사람이 채택한 불변 버전으로 저장. 수정은 `supersedesVersionId`가 있는 새 버전 |
| POST /sessions/:id/meeting/decisions/withdraw | `MeetingWithdrawDecisionRequest` | 사람의 철회 사유를 별도 기록. 후보·철회/대체된 버전은 새 실행 인계 불가 |
| POST /sessions/:id/meeting/handoffs | `MeetingHandoffRequest` | 채택한 결정의 초안/시작. 같은 프로젝트 일반 세션만 대상, 실행 구성·완료 기준 고정. `{handoff:MeetingHandoffReceipt}` |
| GET /sessions/:id/meeting/handoffs/:commandId | — | 저장된 receipt와 기존 시작 결과를 대조. 새 실행은 하지 않음 |
| GET /sessions/:id/meeting-handoffs | — | 출처/대상 양방향 인계 이력 `{handoffs}`와 Run·결과 상태 |
| POST /sessions/:id/meeting/handoffs/:commandId/start | `MeetingHandoffStartRequest` | 저장된 초안의 동일 항목·실행 구성으로 명시 시작. 대상의 미전송 입력·진행 중 작업을 다시 확인 |
| POST /sessions/:id/meeting/handoffs/:commandId/cancel | — | 취소 의도를 저장하고 시작/Run 취소를 확인. 확인 실패는 uncertain으로 남겨 같은 인계에서 재확인 |
| POST /sessions/:id/meeting/handoffs/:commandId/rediscuss | `{commandId,mode}` | 종료된 결과·출처 ID를 고정해 새 대화 메시지로 보낸다. 자동 토론 없음 |
| POST /runs/explain | `{commandId, sessionId, question, modelProfile, mode, startFrom?}` | 결과 질문 Run(에이전트 하나). 세션의 프로젝트에 기록. 도구 없는 최종 답 역할로 답한다. Studio 입력창은 더 이상 쓰지 않으며 기존 클라이언트용으로 유지 |
| POST /runs/auto | `{schemaVersion, commandId, sessionId, brief, choice, mode, startFrom?, conversation?, references?, team?}` | 모델이 기본 템플릿을 고른 뒤 `{runId,receipt,autoRoute}`. 같은 ID·같은 내용은 재사용하고 다른 내용은 409. 선택 비용은 실행 예산에 포함. `team: 'none' \| 'auto' \| {corralId}`를 주면 선택 요청 없이 대화 리드 한 명으로 시작하고 `autoRoute`는 null. none은 명시 요청 때만 부르는 helper, auto는 자동 팀 역할, corralId는 그 Corral의 역할을 리드의 위임 대상으로 준다. 없는 Corral은 `TARGET_NOT_FOUND` |
| POST /runs/auto/:commandId/cancel | `{sessionId,cancelCommandId}` | 시작 전 취소는 세션 범위의 영구 명령으로 저장하고 선택을 중단한다. 원래 시작 명령을 확인한다. 이미 시작됐으면 기존 Coordinator cancel 경로를 사용하며 `{start,cancellation}` receipt를 돌려줘 UI가 확정된 실행을 놓치지 않게 한다 |
| GET·PUT·PATCH·DELETE /projects/:id/workspace | PUT `{path}`, PATCH `{trusted?, verifyCommands?}` | 작업 폴더 연결·신뢰·검증 명령. Corral 데이터 안 폴더는 `CAPABILITY_DENIED` |
| GET·POST·DELETE /sessions/:id/worktree | — | 세션 작업 복사본(신뢰한 Git 저장소의 HEAD에서). 응답은 기존 필드에 `bindingId`·`copyGeneration`을 포함하며 같은 session 사본 재생성 시 generation 증가. active/uncertain reader·writer가 있는 사본 제거는 거절 |
| GET /projects/:id/workspace/files · GET /sessions/:id/worktree/files | `path?` 상대 폴더 | 읽기 전용 파일 목록 `{files:[{path,bytes}],truncated}`. Git ignore 적용, 최대 500개. `.git`·`.corral`·symlink 제외 |
| GET /projects/:id/workspace/search · GET /sessions/:id/worktree/search | `q?`(≤200자), `limit?`(1–50, 기본 20) | `@` 참조용 이름 검색 `{items:[{path,kind:'file'\|'folder'}],truncated}`. fuzzy 순위(파일명 우선), Git ignore 적용, 후보 5만 개, 내용은 읽지 않음, symlink 제외 |
| GET /projects/:id/workspace/file · GET /sessions/:id/worktree/file | `path` 상대 파일 | `{path,content}`. content는 text/binary/too_large. UTF-8·1 MiB 제한. 원본·복사본은 등록된 scope로만 선택하며 agent read ledger·권한을 바꾸지 않음 |
| GET /projects/:id/workspace/git/status · GET /sessions/:id/worktree/git/status | — | `GitStatus`: 현재 `UserGitTarget`, `head`(oid/branch/upstream·ahead/behind/detached/unborn/shallow), 실제 사용자 index의 `indexHash`, staged/unstaged/untracked·rename/unmerged 목록, `truncated`, `filtersDisabled`, 읽기 전용 `branches`(local, 최대 200)·`remotes`. 최초 조회는 현재 대상을 발견하며 expected target을 받지 않음 |
| GET /projects/:id/workspace/git/diff · GET /sessions/:id/worktree/git/diff | `target` JSON, `side` staged\|unstaged\|untracked, raw 상대 `path`, `head` OID(빈 문자열은 unborn null), `indexHash` | `GitDiffRequest`의 정확한 target·HEAD/index 및 읽기 전후 기준을 확인. `GitDiff`는 원래 기준과 `filtersDisabled`, 선택적 rename `originalPath`, `kind:diff`의 before/after(text/binary/too_large/absent) 또는 `kind:unsupported`의 reason(symlink/gitlink/unmerged). 변경된 대상·HEAD/index는 409 `REVISION_CONFLICT` |
| POST /sessions/:id/worktree/git/operations | `GitWriteCommand` | 관리 사본 쓰기: `stage`/`unstage`(literal 상대 `paths`), `commit`(`message`, 확인한 `staged` 목록, `runHooks`, 선택 `author`). `branch{name}`, `switch{branch}`, `fetch{remote}`, `pull{remote,branch}`(fast-forward만), `push{remote,branch,runHooks}`(force 없음). 실패 `reason`에 `branch_in_use`·`dirty_tree`·`non_fast_forward`·`remote_unavailable` 추가. 공통 `operationId`, session `WorkspaceTarget`, `expect:{head,indexHash}`. 신뢰 프로젝트만 접수, 공통 writer 사용. 응답은 `GitOperation` receipt(`git.stage`\|`git.unstage`\|`git.commit`, state, result `applied{head,indexHash,commit?,signed?,hooksRan?}` 또는 `error{code,message,reason?}`). 기준 변경은 receipt의 `REVISION_CONFLICT`, 같은 ID·다른 내용은 409. 원본 폴더 경로는 없음 |
| GET /sessions/:id/worktree/git/operations/:operationId | — | 원래 receipt. running/uncertain이고 이 host에서 진행 중이 아니면 HEAD·index를 다시 읽어 확인되는 경우에만 succeeded/failed로 정리한다. 자동 재실행 없음 |
| POST /sessions/:id/worktree/git/operations/:operationId/cancel | — | 진행 중인 Git process group(hook 포함)을 종료한다. 결과는 같은 receipt로 조회 |
| GET /sessions/:id/worktree/git/hunks | `GitHunksRequest`: diff와 같은 target JSON·head·indexHash·path, side staged\|unstaged | 관리 사본의 실제 index hunk. 불변 `identity`·hunk ID·표시용 patch 또는 미지원 이유. 클라이언트 patch를 쓰기로 받지 않음 |
| GET /sessions/:id/worktree/git/sequence | — | `GitSequenceState`: 현재 대상·HEAD/index·working tree hash, merge/rebase의 identity·원래 HEAD·onto, 충돌 경로와 owner. 조회만으로 실행·소유권 해제하지 않음 |
| GET /sessions/:id/worktree/git/conflict | `GitConflictRequest`: target JSON·path·head·indexHash·sequenceIdentity(빈 문자열은 null) | 고정한 상태의 base/ours/theirs/current. 텍스트·없음·binary·대용량과 미지원 이유를 구분 |
| POST /sessions/:id/worktree/git/advanced-operations | `GitHunkWrite` 또는 `GitSequenceCommand` | 명시 stage_hunks/unstage_hunks 또는 local merge/rebase/continue/abort. 기존 전체 파일 쓰기와 별도 효과 판별을 쓰지만 공통 operation/writer 원장을 공유. 모든 요청의 operation ID·target·HEAD/index를 고정하고 sequence 명령은 working tree hash·sequence identity도 요구. abort는 `confirmed:true` 필요 |
| GET /sessions/:id/worktree/git/advanced-operations/:operationId | — | 동일 ID의 `GitAdvancedOperation` receipt를 읽음. 실행/불확실 상태를 새 명령으로 재전송하지 않음 |
| POST /sessions/:id/worktree/git/advanced-operations/reconcile | `GitAdvancedReconcile`: target·operationId | 불확실 효과의 명시 재확인. 현재 상태에서 증명할 수 없는 결과는 불확실로 유지 |
| POST /sessions/:id/worktree/git/advanced-operations/:operationId/cancel | `{}` | 소유한 Git 작업의 취소 요청. 실제 효과와 정리는 같은 receipt에서 확인 |
| GET /sessions/:id/worktree/tasks | — | `{candidates:TaskCandidates, tasks:UserTaskView[]}`. 후보는 사본 최상위 `package.json` scripts와 lockfile로 고른 `packageManager`(pnpm\|yarn\|npm\|null)이며 읽기만 한다. 사본이 없으면 빈 후보다. 열린 receipt의 process group이 사라졌으면 이때 정리한다 |
| GET /sessions/:id/worktree/debug | — | `DebugState`: 현재 target, Linux·신뢰에 따른 availability, 등록 구성, debug session의 generation/revision/pauseId·상태·중단점·한정된 출력. 조회나 패널 열기로 실행하지 않음 |
| POST /sessions/:id/worktree/debug/inspect | `DebugInspect` | target·configId와 선택한 소유 task/port 또는 preview lease를 검토해 `DebugInspection` 반환. 등록 adapter/config·configRevision·fingerprint·trust를 확인하며 실행은 하지 않음. 임의 PID·외부 주소는 받지 않음 |
| POST /sessions/:id/worktree/debug/start | `DebugStart` | 검토한 target/configRevision/fingerprint, requestId/clientId와 명시 `trust`로 시작. 같은 requestId/본문은 기존 `DebugSession` 반환. 공통 debug owner·process 예약 사용; 공유 개발의 허용된 사람 효과. launch는 소유 Node/Chromium, attach는 확인한 같은 사본의 task |
| POST /sessions/:id/worktree/debug/breakpoints | `DebugBreakpoints` | target/generation·commandId·상대 path·저장 파일 sha256·1-based lines. 파일과 세션을 재확인하고 설치 결과의 verified/line을 `DebugCommandResult`에 반환. 현재 실행 전에 모두 설치됐다고 보장하지 않음 |
| POST /sessions/:id/worktree/debug/query | `DebugQuery` | 현재 target/generation/pauseId의 threads/stack/scopes/variables. 연결별 frame/variable 참조를 확인하고 `DebugQueryResult` 반환. source map·경로·저장 hash가 확인된 사본 파일만 탐색 가능 |
| POST /sessions/:id/worktree/debug/commands | `DebugCommand` | commandId·target/generation·revision/pauseId를 고정한 pause/continue/next/stepIn/stepOut/evaluate/disconnect/stop. evaluate는 명시 표현식 실행 효과. launch는 stop, attach는 disconnect를 사용하며 후자는 원래 task를 종료하지 않음. 응답 유실은 같은 command receipt 조회 |
| GET /sessions/:id/worktree/debug/commands/:generation/:commandId | — | 해당 debug generation의 `DebugCommandResult`. 재시작·늦은 응답·불확실 명령을 새 ID로 재실행하지 않음 |
| GET /sessions/:id/worktree/deployments | — | `DeploymentList`: 현재 등록 profiles와 세션 deployment receipt. 등록 목록과 과거 결과를 읽기만 함 |
| POST /sessions/:id/worktree/deployments/inspect | `DeploymentInspect` | target/profileId → `DeploymentPlan`: 환경·명령·credential 환경 변수 이름, configRevision, source commit/tree/dirty, fingerprint. 원래 source/명령/참조를 검토하며 외부 배포하지 않음 |
| POST /sessions/:id/worktree/deployments | `DeploymentStart` | operationId·target/profileId·검토 fingerprint·allowDirty. source/실행 파일/명령/credential 값을 재검증한 strict writer와 소유 process로 실행. 공유 개발 중 거절. `DeploymentView`의 phase/exitCode/cleanupConfirmed와 외부 readback은 별개이며 exit 0도 결과 미확인이면 uncertain |
| GET /sessions/:id/worktree/deployments/:operationId | — | 원래 target/plan의 `DeploymentView` 조회. 실행·결과 확인·재배포를 자동으로 하지 않음 |
| POST /sessions/:id/worktree/deployments/:operationId/check | `DeploymentAction`: `{target}` | uncertain이고 소유 프로세스 정리가 확인된 operation에 한해 등록된 결과 확인 명령 실행. 원래 command/credential fingerprint와 응답의 operation/environment/source/deployment identity를 확인. 유효한 결과만 pending/succeeded/failed로 구분하며 미확인은 uncertain 유지 |
| POST /sessions/:id/worktree/deployments/:operationId/stop | `DeploymentAction`: `{target}` | 소유 로컬 프로세스를 중지하고 정리 확인 뒤 예약 해제·terminal cancelled. 외부 배포는 취소하거나 rollback하지 않으며 외부 결과 미확인을 보존. 이후 이 operation의 앱 내 check는 실행하지 않고 대상 서비스에서 수동 확인 |
| POST /sessions/:id/worktree/search-contents | `ContentSearch` | Exact managed-copy target·queryId·literal single-line query·caseSensitive. Disk-only `ContentSearchResult`: bounded matches with byte SHA-256 and 1-based UTF-16 range, scanned/skipped counts, truncated. Existing ignore/protected-path/read policy, 500 files/1 MiB per file/8 MiB total/200 matches. HTTP disconnect cancels work; no original-folder/index/draft writes |
| GET /sessions/:id/worktree/edit-proposals | — | 현재 세션의 저장된 변경 제안 요약. 조회는 파일을 적용하거나 uncertain 예약을 해제하지 않음 |
| POST /sessions/:id/worktree/edit-proposals | `FileEditPreview` | `replace`, `rename`, `code_actions` → `{proposals,unavailable}`. 안정된 requestId·exact target, 저장된 파일만 불변 before/after/hash로 검토. 32파일·합계 8 MiB, 잘린 검색·명령/파일 resource operation 자동 실행 없음. HTTP 연결 종료는 제안 계산 취소 |
| GET /sessions/:id/worktree/edit-proposals/:proposalId | — | 해당 세션의 고정된 제안 본문·hash·dismissed·operationId. 다른 사본의 제안을 현재 대상으로 승격하지 않음 |
| POST /sessions/:id/worktree/edit-proposals/:proposalId/apply | `FileEditApply` | `{operationId,target,proposalHash}`. `document.batch` 사람 owner, 전체 사전 검사와 파일별 CAS/원자 교체. 동일 ID는 기존 receipt를 반환. 응답 유실 뒤 새 ID로 재적용하지 않음 |
| POST /sessions/:id/worktree/edit-proposals/:proposalId/dismiss | `FileEditDecision` | 확인한 target/hash의 미접수 제안만 닫음. 실제 파일·이미 접수된 효과는 취소하지 않음 |
| POST /sessions/:id/worktree/edit-proposals/:proposalId/inverse | `FileEditInverse` | 확인한 원래 operation의 applied 파일이 현재 afterHash와 같을 때만 역제안을 생성. 별도 diff 검토·적용이 필요하며 자동 rollback하지 않음 |
| GET /sessions/:id/worktree/edit-operations/:operationId | — | `FileEditOperation`: 파일별 applied/unchanged/uncertain 결과. 일부 실패는 성공으로 숨기지 않고 불확실 writer를 조회만으로 풀지 않음 |
| POST /sessions/:id/worktree/edit-operations/reconcile | `FileEditReconcile` | `{target,operationId}`. 불확실 효과의 현재 파일을 명시 재확인하고 모두 before/after 중 하나로 확인됐을 때만 예약을 정리. 파일 쓰기/재실행 없음 |
| GET /sessions/:id/worktree/language | — | `LanguageState`: target, supported host/trust availability, registered server choices, active/failed/uncertain session + versioned or version-unknown diagnostics |
| POST /sessions/:id/worktree/language/inspect | `LanguageInspect` | Current managed-copy argv/config revision/fingerprint and trust; no process execution |
| POST /sessions/:id/worktree/language/start | `LanguageStart` | Exact target + reviewed fingerprint/revision + clientId/requestId; optional explicit `trust:true`. One passive language owner per copy. Same ID/contents never starts another process |
| POST /sessions/:id/worktree/language/document | `LanguageDocumentChange` | Full-text sync or close with target/generation/controller/path/version. 1 MiB/file, 64 documents/8 MiB total. No disk writes. Older/different-body versions rejected |
| POST /sessions/:id/worktree/language/query | `LanguageQuery` | Completion/definition/references/pull diagnostics; UTF-16 and current generation/document versions. Bounded sanitized results; changed document set rejects late results; disconnected HTTP cancels the query |
| POST /sessions/:id/worktree/language/stop | `LanguageScope` | Stops only the exact generation and confirms its owned process-session cleanup. Unknown cleanup keeps the reservation; old stop never ends a new session |
| GET /sessions/:id/worktree/development | — | `DevelopmentState`: 현재 `WorkspaceTarget`, local opt-in·신뢰에 따른 `available`, running/uncertain development `operation` 또는 null |
| POST /sessions/:id/worktree/development | `DevelopmentStart` | `{operationId,target}`. 신뢰한 로컬 관리 사본의 development writer 접수. 기본 비활성 host는 `CAPABILITY_DENIED`, 잘못된 target/generation은 `REVISION_CONFLICT`. 동일 ID·본문은 재실행 없이 현재 `DevelopmentState` 반환. 종료된 ID로 다시 켜지 않음 |
| POST /sessions/:id/worktree/development/:operationId/finish | `{target: WorkspaceTarget}` | 정확한 development owner 종료. 다른 사람 active/uncertain owner가 남으면 `RUN_ALREADY_ACTIVE`. 이미 끝난 ID는 이후 새 owner를 종료하지 않음. uncertain도 명시 종료·정리 확인 필요 |
| POST /sessions/:id/worktree/tasks | `TaskStart` | `operationId`, session `WorkspaceTarget`, `script`. 인간 operation `task`로 접수해 기본 모드에서는 writer, 공유 모드에서는 하위 access를 수명 동안 보유하고 `<pm> run <script>`를 소유 process group으로 실행. 없는 script는 `TARGET_NOT_FOUND`, 활성 writer는 409 `RUN_ALREADY_ACTIVE`. 응답 `UserTaskView`(state, pid, exitCode, cleanupConfirmed) |
| GET /sessions/:id/worktree/tasks/:operationId/output | `offset` | `{text,nextOffset,bytes,truncated}`. 이 host에서 실행한 task의 출력만 있으며 재시작 뒤에는 빈 출력 |
| POST /sessions/:id/worktree/tasks/:operationId/stop | — | process group을 끝내고 정리를 확인한 receipt(`cancelled`, `cleanupConfirmed`). 확인하지 못하면 `uncertain`. preview(`POST /sessions/:id/previews`)의 `operationId`는 실행 중인 사용자 task도 받는다 |
| GET /sessions/:id/worktree/document | `path` 상대 파일 | 관리 사본 문서 `{target,path,content,version,writable}`. target은 host의 workspace identity·project/binding/session/copyGeneration. UTF-8 ≤1MiB는 BOM 포함 text와 full SHA-256·bytes·BOM/EOL, binary/too_large는 version:null·writable:false. 새 파일 경로는 absent. 기존 원본 browse는 읽기 전용 유지 |
| POST /sessions/:id/worktree/documents | `DocumentCommand` | save/create(`baseHash:null`), rename(빈 목적지만), delete(`confirmed:true`·원본 hash·복구 checkpoint). 공통 writer와 기존 lease 사용. 접수 후 `DocumentOperation` receipt, 접수 전 잘못된 target/권한/owner는 기존 오류 코드. JSON 표현은 route별 7MiB, 실제 파일은 UTF-8 1MiB 제한 |
| GET /sessions/:id/worktree/document-operations/:operationId | — | 원래 대상과 operation ID의 receipt. pending·완료·실패 모두 상대 path/precondition/제출 hash의 intent를 보존하며 원문 text는 저장하지 않는다. 현재 사본 삭제/재생성 후에도 완료 receipt를 조회한다. 같은 ID/다른 내용은 conflict, uncertain을 자동 재실행하지 않는다 |
| GET /sessions/:id/terminals | — | 현재 target·가용 shell·사용자 터미널 목록. 작업 사본이 없어도 과거 terminal 상태/중지 대상은 조회 가능 |
| POST /sessions/:id/terminals | `TerminalCreate` | target·operationId·shellId·초기 cols/rows. 공통 writer와 host process permit을 접수하고 starting receipt 반환. 같은 ID/같은 내용은 기존 결과, 다른 내용은 conflict |
| GET /sessions/:id/terminals/:terminalId | — | `TerminalView`: generation·state·size·lastSequence·replayAvailable·controller. OS PID/identity·절대 경로는 공개하지 않음 |
| POST /sessions/:id/terminals/:terminalId/control | `TerminalControllerChange` | target/generation·attachmentId·expectedGeneration·claim/release·명시 takeover. 한 controller만 입력하며 takeover는 같은 attachment에도 generation을 바꿈 |
| POST /sessions/:id/terminals/:terminalId/input | `TerminalInput` | controllerGeneration·sequence·UTF-8 ≤16KiB data. input/resize 공통 순서, 같은 최신 순서/내용만 기존 ack. 자동 stdin 재시도 없음 |
| POST /sessions/:id/terminals/:terminalId/resize | `TerminalResize` | controller의 공통 순서로 cols 2–500, rows 1–500. 성공한 resize도 output sequence에 포함 |
| POST /sessions/:id/terminals/:terminalId/stop | `TerminalIdentity` | target/generation 확인 후 OS 세션 종료 증거에 따라 상태/예약 정리. 불명확하면 uncertain 유지 |
| GET /sessions/:id/terminals/:terminalId/events | generation, after 또는 Last-Event-ID | 인증된 SSE. sequenced output/resize와 unsequenced 현재 status. 화면 detach는 구독 해제만 하며 PTY를 종료하지 않음 |
| GET /sessions/:id/worktree/removal | — | 사본 삭제 전 요약(읽기 전용): bindingId·copyGeneration·missing, 사본의 Git 변경 수(읽지 못하면 null), active/uncertain owner(사람 operation 종류), 미제출 검토 의견·planned/uncertain 쓰기 수, 끝나지 않은 Run |
| DELETE /sessions/:id/worktree?generation= | — | 사본 삭제. generation이 지금 사본과 다르면 `REVISION_CONFLICT`. owner가 있거나 폴더가 남으면 거절하고 삭제로 기록하지 않음 |
| GET /sessions/:id/changes?scope=session\|review\|run&runId= | — | 비교 범위의 from·to tree와 파일 목록(상태·줄 수·바이너리·출처·이전/이후 blob). 출처는 `managed_agent`(Corral의 마지막 적용 쓰기 그대로)·`mixed`(Corral이 바꾼 뒤 다른 쓰기가 섞임)·`external_observed`(Corral이 바꾸지 않음) |
| GET /sessions/:id/changes/file?from&to&path | — | 두 tree의 파일 내용(text·binary·too_large·absent) |
| POST /sessions/:id/reviewed | — | 지금 사본 전체를 읽음 기록으로 남김("읽음 기록 이후" 범위의 기준). 파일 검토·승인 아님 |
| GET·POST /sessions/:id/verifications | POST `{commandId}` | 검증 명령 실행(202)과 결과 목록. `stale`은 실행 tree가 현재 사본과 다름, `configChanged`는 그 검사의 등록 명령 정의가 지금과 다르거나 삭제됨(다른 검사 변경은 제외) |
| GET /sessions/:id/file-operations | — | broker가 한 파일 쓰기 기록(planned·applied·failed·uncertain) |
| GET·POST /sessions/:id/comments, PATCH …/comments/:commentId | `{from, to, path, side, startLine, endLine, quote, body}` / `{state}` | 두 tree에 묶인 검토 의견. 초안만 지울 수 있음 |
| POST /sessions/:id/feedback/text, POST /sessions/:id/feedback | `{commentIds}` / 보낸 결과 | 의견 묶음의 본문과, 지시·새 Run으로 보낸 기록 |
| GET·POST /sessions/:id/decisions | `{from, to, decision, note}` | 승인·수정 요청. 작업 복사본이 바뀌면 `stale`. Studio는 정확한 from/to가 같은 판단만 현재 비교의 판단으로 표시 |
| GET /sessions/:id/integration-plan?decisionId= | — | 파일별 apply·skip·conflict |
| GET·POST /sessions/:id/integrations, POST …/:integrationId/revert | `{decisionId}` | 원본 폴더 반영·되돌리기, 파일별 결과 |
| GET /projects/:id/inbox | — | 사람이 처리할 항목(결정 대기·대기열·결과 모르는 쓰기·반영 문제·검증 실패·검토 뒤 쓰기) |
| POST /projects | `{name, description?}` | 폴더 없는 새 프로젝트(이름 1–80자, 같은 이름 허용) |
| PATCH /projects/:id | `{name?, description?, archived?, expectedRevision}` | 이름·설명·보관. 다른 revision `REVISION_CONFLICT`, 기본 프로젝트 보관·빈 이름 `SCHEMA_INVALID` |
| DELETE /corrals/:id | — | 저장 정의 삭제. 이미 시작한 Run의 snapshot에는 영향 없음 |

Git 읽기의 target은 `{kind:project,hostId,projectId,bindingId}` 또는 `{kind:session,...WorkspaceTarget}`이며 서버의 기존 binding·canonical root·generation 검증과 HTTP 인증을 사용한다. `indexHash`는 해당 대상의 `ls-files --stage -z` 출력 hash이고 index가 없으면 빈 출력 hash다. status 출력 64MiB·목록 2,000개와 본문 1MiB 한도를 적용하며 초과·실패를 clean으로 표시하지 않는다. 공백·한글·개행을 포함한 path는 URLSearchParams와 NUL machine format으로 보존한다. 읽기는 operation 원장 접수·writer 예약·index 변경을 하지 않고 hooks/filter/textconv/extdiff/fsmonitor/lazy fetch를 실행하지 않는다. configured filters가 있으면 `filtersDisabled:true`로 변환 전 원문임을 표시한다. submodule은 gitlink 변경만 관찰하고 내부 dirty 상태를 조사하지 않는다. refresh에서 target이 바뀌면 선택을 해제하며 이전 diff를 새 대상으로 자동 재시도하지 않는다. 기존 내부 snapshot helper와 관리 사본 Git 쓰기 실행 허가는 이 API와 별개다. 타입 정본은 `packages/contracts/src/user-git.ts`다.

P8 입력·기록 주소. 문서 도구에는 이 주소에서 받은 ID만 전달하며 로컬 경로나 원시 URL을 전달하지 않는다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /documents | — | 등록 입력의 ID, 종류, 제목, MIME, 바이트 수. 원문·원시 URL 없음 |
| POST /documents/import | `{title,mimeType,text}` 또는 `{url}` | `text/plain`·`text/markdown` 문서를 불변 `documentId`로 저장하거나 공개 HTTPS DNS를 확인하고 `sourceId`로 등록. 중복 입력은 같은 ID |
| POST /runs/:id/export | `{privateTranscript?:boolean}` | 기본은 원문 없는 공개 요약. 명시적 `true`만 비공개 원문 archive |
| POST /history/import | archive | 검증한 읽기 전용 기록. 실행·effect 재전송·현재 workspace 기록 삽입 없음 |

`POST /session`은 기존 204 응답과 함께 `x-corral-csrf` 헤더도 반환한다. 그 외 API 변경 요청은 세션 cookie, 허용 Origin, 세션 CSRF token을 모두 요구한다. API query string의 credential 키 이름은 거절하며 값은 오류에 반영하지 않는다. 요청 본문은 2 MiB(초과 413), 등록 문서는 UTF-8 1 MiB, workspace 입력은 32 MiB·1,000개로 제한한다. 로컬 서버 전체에서 분당 읽기 1,200회·변경 120회(bootstrap 포함), 동시 SSE 16개를 허용하며 초과 시 429다.

`read_document`는 `{documentId}` 또는 `{sourceId}`만 받는다. URL 읽기는 live Run에서만 실행하며 각 연결·redirect에서 모든 DNS 주소를 검사하고 검사한 IP로 연결을 고정한다. HTTPS 443·정상 TLS 인증서·최대 3회 redirect·전체 30초·1 MiB·UTF-8 text/Markdown만 허용한다. HTML·압축 응답·사설/특수 주소·URL 자격 증명은 거절한다. 원격 본문도 불변 documentId로 저장한다.

`search`는 `{query,provider?:"corpus"|"brave",limit?:1..10}`이며 기본은 등록 문서의 키 없는 corpus 검색이다. Brave는 live Run, 명시적 `provider:"brave"`, 서버의 `--allow-live-search`, backend 환경의 `BRAVE_SEARCH_API_KEY`를 모두 요구한다. `--search-request-limit`은 서버 세션 전체의 요청 수(실패 포함)를 제한하며 기본 10·최대 100이다. 자동 재시도·provider 전환은 없고, 결과 URL은 검증 후 sourceId로만 반환한다. Provider 인증 헤더는 redirect에 전달하지 않는다.

모델 로그인 주소. 응답은 상태와 만료만 담고 token·키·콜백 주소는 담지 않는다.

| Method/path | 요청 | 응답·효과 |
|---|---|---|
| GET /model-profiles | — | profileId, provider, modelId, modelName, available, reasoning, contextWindow, maxOutputTokens, method(`oauth`·`api_key`·null), keyConfigured |
| GET /model-auth | — | provider별 signedIn, method, subscription, expiresAt, 진행 중 login(state·authUrl·error) |
| PUT /model-auth/:provider/api-key | `{key, revision?}` | 프로필의 provider 또는 등록 endpoint에 키 저장. optional config revision 불일치 시 `REVISION_CONFLICT`; 응답은 인증 상태만 포함 |
| POST /model-auth/:provider/login | — | 202. provider 자체 로그인 시작. 사용자가 여는 authUrl을 돌려준다 |
| POST /model-auth/:provider/login/callback | `{url}` | 브라우저의 최종 redirect 주소(자동 콜백이 닿지 않을 때) |
| DELETE /model-auth/:provider/login | — | 진행 중 로그인 취소 |
| DELETE /model-auth/:provider | — | 로그아웃. 저장한 자격 증명 삭제 |

SSE는 영속 이벤트(`event: domain`, `id: runSeq`) 외에 모델 출력 조각을 `event: stream`으로 보낸다. 이 frame에는 id가 없어 재접속 cursor를 움직이지 않고, 저장하지 않으며, 나중에 연결한 구독자에게 다시 보내지 않는다. live 실행 전에 로그인이 없으면 `POST /runs`는 403 `CAPABILITY_DENIED`다.

`POST /runs`는 `CreateRunRequest`만 받는다(정의 본문을 직접 보내면 400). 같은 commandId의 재전송은 200과 처음 receipt, 새 Run은 201이다. 두 번째 활성 Run은 409 `RUN_ALREADY_ACTIVE`다. `PUT /corrals/:id`는 `If-Match`에 기준 definition revision이 없으면 400, 다르면 409 `REVISION_CONFLICT`다. 명령 응답의 HTTP 상태는 receipt를 따른다: 거절은 오류 코드의 상태, `accepted`·`queued`는 202, 그 밖은 200이다.

SSE event는 `id: runSeq`, `event: domain`을 가진다. SnapshotSeq 이하 event는 재적용하지 않는다. Last-Event-ID와 after가 충돌하면 서버 계약으로 하나를 선택하고 오류/우선순위를 문서화한다. 첫 구현은 Last-Event-ID가 유효하면 우선한다. 범위 밖 cursor·다른 Run cursor는 400이다.

### 등록 구성과 결과 확인

기존 `ProjectToolConfig`에 optional `debugAdapters`, `debugConfigurations`, `deployments`를 추가한다. 한 설정 폼이 저장할 때 다른 도구 family를 지우지 않으며 기존 config revision 검사를 유지한다. DAP 구성과 배포 명령의 환경 설정은 호스트 변수의 **이름 참조**이며 값을 클라이언트에 돌려주거나 별도 credential 저장소에 복사하지 않는다.

배포·결과 확인 명령에는 원래 `CORRAL_DEPLOYMENT_OPERATION`, `CORRAL_DEPLOYMENT_ENVIRONMENT`, `CORRAL_DEPLOYMENT_COMMIT`(unborn이면 빈 문자열), `CORRAL_DEPLOYMENT_TREE`를 전달한다. 결과 확인 명령은 출력 한도 안의 단일 JSON `DeploymentReadback`을 반환한다: `operationId`, `environment`, `sourceCommit`(unborn이면 null), `sourceTree`, `deploymentId`, `status`(`pending`/`succeeded`/`failed`), `url`(또는 null). command exit 0·출력 잘림 없음·프로세스 정리와 원래 operation/환경/source의 일치를 모두 확인해야 결과로 채택한다. 한 번 확인된 deploymentId가 다른 값으로 바뀐 응답은 대체하지 않는다. URL은 자격 증명·query·fragment가 없는 HTTPS 또는 loopback HTTP만 허용한다.

배포 명령의 로그나 URL처럼 보이는 텍스트만으로 성공을 판정하지 않는다. 명시 종료로 예약을 해제한 뒤에는 같은 operation에서 확인 명령을 재시작하지 않는다. 외부 배포 결과 미확인은 남으며 실제 provider 검증과 로컬 fixture 결과는 별도 증거다.

## 2. Receipt

receipt는 commandId, runId, status, acceptedSeq, target, requestedBoundary, relatedEventIds, error를 갖는다. status는 `accepted / queued / applied / rejected / superseded / expired / cancelled`다. 일부 target에만 적용하는 다중 대상 steer는 MVP에 제공하지 않아 부분 적용 모델을 미룬다.

steer receipt의 applied는 입력 dispatch 확인을 의미한다. 품질 준수 여부는 review로 별도 표시한다. 설정 patch의 applied는 policy commit이며, 미래 execution이 실제 사용한 patch.activated와 구분한다.

## 3. 오류

| 코드 | HTTP | 의미 |
|---|---|---|
| SCHEMA_INVALID | 400 | 이해하지 못하는 형식·unknown field |
| GRAPH_INVALID | 422 | 포트·Loop·role·binding 등 의미 불일치 |
| CAPABILITY_DENIED | 403 | 도구/질문/위임 관계가 허용되지 않음 |
| STALE_CONTROL_REVISION | 409 | 준비 중 다른 제어 변경이 발생 |
| IDEMPOTENCY_CONFLICT | 409 | 같은 commandId에 다른 payload |
| TARGET_NOT_FOUND | 404 | 대상 Run·실행·작업이 없음 (구현 중 추가) |
| COMMAND_NOT_SUPPORTED | 501 | 형식은 올바르지만 현재 runtime 단계에서 아직 처리하지 않는 명령. 효과 없음 (구현 중 추가) |
| TARGET_TERMINAL | 409 | 종료된 실행에 지시 등 적용 불가 |
| REVISION_CONFLICT | 409 | Corral 저장의 기준 definition revision이 현재와 다름(다른 탭에서 저장). 저장하지 않음 (구현 중 추가) |
| RUN_ALREADY_ACTIVE | 409 | workspace에 이미 활성 Run이 있음. 새 Run과 effect 없음 (구현 중 추가) |
| RESOURCE_CAPACITY | 409 | 동적 자식/응답 worker 용량 예약 실패. 부모를 무기한 대기에 넣지 않음 |
| CRITERIA_CHANGE_REQUIRES_NEW_RUN | 409 | Loop가 이미 종료되어 완료 기준 변경은 새 Run 필요 |
| RESTART_NOT_ALLOWED | 409 | 부모가 더 이상 대기하지 않거나 downstream 진행 |
| APPROVAL_STALE | 409 | 대상/기준 버전 변경 또는 이미 해결 |
| LIMIT_REACHED | 409 | 새 effect admission 불가; 별도 approval/상한 변경 필요 |
| STORAGE_UNAVAILABLE | 503 | 사실 기록이 불가하므로 신규 admission 닫음 |
| SESSION_INVALID | 401 | 세션/부트스트랩 오류 |
| ORIGIN_REJECTED | 403 | 허용하지 않는 Origin/Host/CSRF |
| POLICY_ERROR | 500 | admission gate가 예외로 실패해 요청·도구 호출을 거절함(fail closed). 통과로 처리하지 않음 |
| MODEL_UNAVAILABLE | 502 | Run 밖의 모델 요청(팀 초안)이 실패했거나 응답이 계약에 맞지 않음. 응답 원문은 보내지 않음 |
| REQUEST_OUTCOME_UNKNOWN | 409 | 전송 결과가 확인되지 않은 관리형 요청. 같은 operation ID는 저장된 결과만 조회하며 새 유료 호출을 만들지 않음 |

provider/network error는 사용자 키 원문·응답 헤더를 포함하지 않는다. trace용 errorId와 마스킹된 이유를 제공한다. 도구 실행 중 실패는 HTTP success/error와 별개로 ToolOutcome에 structured error를 넣는다.

## 4. 이벤트 payload 목록

payload별 검증은 `packages/contracts`의 Zod discriminated union이 맡는다. causal graph는 cause 1개에 한정하지 않는다.

| type | 반드시 기록할 내용 |
|---|---|
| `run.started` | 정의/입력/모델 snapshot과 최초 limits |
| `run.state_changed` | from,to,reasonCode |
| `run.interrupted` | previousStatus,backendSessionId |
| `execution.created` | parentExecutionId,nodeId,taskId,attemptNo,depth,iterationId |
| `execution.state_changed` | from,to,activity,waitingOn |
| `execution.settled` | outcome,terminationMode,error |
| `task.created` | role,node,contract,dependencies |
| `task.attempt_assigned` | executionId,attemptNo |
| `task.submitted` | artifactVersionIds |
| `task.completed` | completionEvidence |
| `task.blocked` | cause,requiredUserAction |
| `message.question_created` | questionId,taskId,sender,targetRole,body,refs,deadline. 구현: taskId는 이 질문에 답하려고 만든 응답 Task이며, 응답 실행은 질문자의 자식이다 |
| `message.answer_committed` | questionId,responseTaskId,body,refs |
| `message.closed` | questionId,answer|cancel|timeout. 닫힌 뒤의 reply는 `observation.late`(originalEventType `reply`)로만 남는다 |
| `artifact.version_created` | artifactId,version,bodyRef,hash,parentVersion,authorExecutionId,modelCallId,contextSnapshotId |
| `artifact.read` | requestedRef,resolvedVersionId,consumerExecutionId |
| `review.recorded` | reviewVersion,targetVersion,criteriaVersion,verdict,issues |
| `review.stale` | reviewVersion,newCriteriaVersion,cause |
| `loop.iteration_started` | iterationId,no,pinnedCarryInputs,criteriaVersion |
| `loop.iteration_finished` | outcome,submittedVersions |
| `approval.requested` | approvalId,kind,subjectVersions,criteriaVersion |
| `approval.resolved` | decision,actor,subjectVersions. 등록 검사 승인 종료는 선택 reason(cancelled/timeout/execution_ended)과 runtime actor로 기록한다 |
| `directive.accepted` | directiveId,target,body,commandId |
| `directive.attached` | contextSnapshotId,modelCallId |
| `directive.dispatched` | modelCallId,executionEpoch |
| `directive.undelivered` | reason |
| `patch.committed` | patchId,scope,before,after,controlRevision |
| `patch.activated` | patchId,executionId|iterationId |
| `effect.admitted` | effectId,scope,epoch,reservationId |
| `effect.dispatch_observed` | effectId,providerRequestId |
| `effect.settled` | effectId,outcome |
| `tool.requested` | toolCallId,name,validatedArgs |
| `tool.allowed` | toolCallId,policyVersion |
| `tool.blocked` | toolCallId,reason |
| `tool.started` | effectId,toolCallId |
| `tool.finished` | resultRef,error |
| `model.request_prepared` | modelCallId,contextSnapshotId,profile,configRevision |
| `model.finished` | responseRef,rawUsage,normalizedUsage,certainty |
| `model.usage_reconciled` | executionId,modelCallId,rawUsage,normalizedUsage,certainty. 종료 후 새로 확인된 사용량만 보충하며 응답 본문·실행 상태는 바꾸지 않음 |
| `budget.reserved` | reservationId,amount,scope |
| `budget.settled` | reservationId,actual,unknownOutstanding |
| `limit.reached` | limitKind,used,reserved,max |
| `cancel.requested` | scope,fenceSeq,reason |
| `cancel.confirmed` | scope,settlementRefs |
| `observation.late` | originalEvent,whyIgnored |
| `output.finalized` | artifactVersionIds,approvalId |
| `decision.requested` | decisionId,questionKind,questionVersion,provider@version,privacy,subject(runId,executionId,attemptNo,modelCallId,contextSnapshotId),inputHash. |
| `decision.observed` | decisionId,answer,probabilities,evidenceLevel,latencyMs,readyBeforeDispatch,afterRequestFinished. 관찰 전용이며 요청에 적용되지 않음. `readyBeforeDispatch`·`afterRequestFinished`는 기록 시점에 commit된 Run에서 Coordinator가 채운다 |
| `decision.failed` | decisionId,reason(`timeout`·`invalid_response`·`provider_error`·`unavailable`·`cancelled`),latencyMs |

판정(decision) 관련으로 바뀐 기존 payload: `effect.admitted.kind`에 `decision`(외부 provider만), `limit.reached.limitKind`에 `decision_calls`, `run.started.decisions`(선택: 모드·provider snapshot·maxCalls). runtime에 판정 설정이 없으면 `decisions` 필드가 없다(브라우저 데모·기존 Run). 서버는 항상 기록하며 기본값은 `off`다.

구현에서 정한 검토·승인 규칙:

- `approval.requested.kind`는 `user_action`(approval 모드 Decision, 또는 판정할 수 없는 검토), `loop_cap`(Loop 상한에서 한 라운드 더), `final_output`(Output의 `requireApproval`) 중 하나다. `subjectVersions`의 첫 항목이 승인 대상 버전이고, 뒤에 마지막 검토 버전이 붙는다.
- `resolve_approval`의 `subjectVersionId`는 `subjectVersions[0]`이어야 한다. 검사 순서: 없는 승인 `TARGET_NOT_FOUND` → 이미 해결 `APPROVAL_STALE` → `expectedControlRevision` 불일치 `STALE_CONTROL_REVISION` → 다른 버전 `APPROVAL_STALE`. 같은 commandId 재전송은 처음 receipt를 돌려준다.
- 검토 본문이 `review.schema.json`이 아니거나, 대상이 검토자가 받은 입력이 아니거나, 기준이 Run의 `criteriaVersionId`가 아니면 `review.recorded.verdict`는 `inconclusive`이고 `user_action` 승인으로 넘어간다. 통과로 처리하지 않는다.
- 설치 정책의 Loop hard cap에 닿으면 승인 없이 `limit.reached`(`loop_iterations`)와 함께 Run이 실패한다. 거절한 `loop_cap`·`final_output`은 Run을 취소로 끝낸다.
- 같은 Agent가 다음 Loop 라운드에 쓴 버전은 같은 artifactId의 다음 version이다. 투영의 `parentVersionId`가 이전 버전을 가리킨다.

## 5. timeout·재연결·다중 탭

브라우저 timeout은 서버 명령 실패와 같지 않다. 같은 commandId로 receipt를 조회/재전송한다. 새 ID로 취소/승인을 재시도하면 이중 의미가 생길 수 있으므로 client SDK가 처리한다.

workspace의 활성 Run은 하나지만 탭은 여러 개일 수 있다. 탭별 controlRevision 갱신과 conflict UI가 필요하다. SSE가 끊겼다고 Run을 자동 취소하지 않는다. Run-level wall deadline과 승인 대기 상태를 유지한다.

SSE의 일반 미전송 데이터는 다음 UTF-8 frame을 포함해 1 MiB로 제한한다. 초과하면 이미 쓴 prefix를 flush하고 연결을 종료하여 재접속 cursor가 앞으로 진행한다. 단일 committed domain event가 1 MiB보다 크면 구독을 먼저 해제하고 기존 prefix를 flush한 뒤, 그 이벤트 하나를 64 KiB 이하의 UTF-8 바이트 조각으로 순차 전송한다. 각 쓰기의 완료를 기다리며, 완전한 frame을 보낸 뒤 연결을 닫는다. 10초 동안 flush되지 않는 소켓은 강제 종료한다. 다음 연결은 완전히 받은 이벤트의 cursor부터 재개한다. 기존에 저장한 큰 이벤트도 생략·축약하지 않는다.

추가 전송 큐는 1 MiB 이내이고, 큰 이벤트 전송·파싱에는 현재 domain record 하나의 직렬화 크기에 비례하는 메모리가 필요하다. HTTP 입력의 2 MiB 제한이 patch의 before+after나 기존 내부 기록의 event 크기를 제한하지는 않는다. 클라이언트는 서버 형식의 domain frame 하나를 끝까지 조립한 뒤 RunEvent schema를 검사한다. 잘못된 domain event는 오류로 중지하고 무한 재시도하지 않는다. 고정 상한 예외는 128자 이내의 서버 형식 domain 헤더에만 적용한다. domain이 아닌 frame·주석·불완전 헤더는 2 MiB UTF-8 이내다. 비영속 텍스트 frame·heartbeat는 큰 domain event의 예외를 사용하지 않는다.


## 등록 웹 문서의 출처

`read_document({sourceId})`는 live Run의 기존 입력 도구 경로에서만 HTTPS를 수집한다. HTML은 plain text로 추출하며 결과에 `sourceId`, 불변 `documentId`, `source` metadata를 포함한다. 원문/본문 hash, 최초·최종 URL, 수집 시각, extractor 버전과 비신뢰 출처 표시를 보존한다. 같은 URL의 새 수집은 기존 문서를 덮지 않는다. 직접 document import는 기존 plain text/Markdown만 허용한다.

인증된 `GET /api/v1/documents/:documentId/source`는 `{ metadata, rawText }` JSON을 반환한다. `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`를 사용하고 HTML로 렌더링하지 않는다. 형식이 잘못된 ID는 400, 등록 출처가 없는 문서는 404다. 원문까지 포함한 workspace 입력의 저장 용량은 기존 32 MiB 상한 안에서 계산한다.


## Ultra 제거

Ultra는 제거됐다. `POST /api/v1/runs/auto`, 세션 메시지, `autoRoute`를 싣는 시작 요청과 회의 인계 실행은 `qualityPreset`·`ultra`를 알 수 없는 필드로 400 거절하고 아무것도 시작하지 않는다. `select_candidate`·`cancel_candidate` Run command와 `/runs/:id/candidates…` 경로는 없다(각각 400·404).

Bell의 2026-10-25 결정에 따라 이전 Ultra 기록은 읽지 않는다. `candidate.comparison_changed` event, `execution.created.candidateId`, `autoRoute.qualityPreset`·`autoRoute.ultra`는 어떤 schema에도 없다. 저장소에 Ultra Run이 있어도 서버는 시작한다. snapshot의 `autoRoute`가 `qualityPreset`이나 `ultra`를 가진 Run은 모든 `/api/v1/runs/:runId…` 경로에서 `TARGET_NOT_FOUND`(404)와 "This run used Ultra, which was removed; it cannot be opened."로 거절되고, 그 snapshot·event는 client에 보내지 않는다. 끝나지 않은 Ultra Run은 다른 Run처럼 재시작 때 중단된다. 그 Run의 "다시 요청"과 Ultra를 기록한 회의 인계의 시작·재전송은 거절하며, 사람이 요청을 새로 보낸다. 세션 항목에 저장된 Ultra 선택은 무시한다.


## 사용자 PTY 전송과 복구

정본 schema는 `packages/contracts/src/terminal.ts`다. 기존 Host/Origin/cookie/CSRF 경계를 유지한다. input/resize만 일반 mutation 횟수 대신 host 공통 1초당 120 frames·256KiB 예산을 사용한다. malformed frame도 예산에 포함한다. ack는 host 수신 확인이며 명령 완료가 아니다. UI는 UTF-8 16KiB로 나누되 64KiB 대기 입력을 넘는 전체 붙여넣기는 거절하며, 연결 유실로 확정되지 않은 입력은 자동 재전송하지 않는다.

출력은 최초 크기와 처음부터의 ANSI/resize 순서를 4MiB까지 보관한다. 초과하면 prefix를 폐기하고 replayAvailable=false로 표시한다. 이미 연결된 화면은 이어 읽지만 새 화면이나 cursor gap에 임의 ANSI tail을 주어 복구 성공으로 표시하지 않는다. 종료 후 보관은 5분이며 그 뒤 재생 불가를 명시한다. status metadata는 출력 cursor를 전진시키지 않는다. client는 xterm write callback 완료 후 cursor를 갱신한다. 느린 viewer는 기존 bounded SSE writer로 분리하고 셸은 유지한다.

터미널은 Run과 다른 사용자 owner이고 관리 사본의 writer 및 host 공통 12 process permits를 사용한다. 터미널을 실행 중인 사본은 파일 저장/새 writer Run을 거절한다. 다른 사본의 Run 취소는 이 PTY의 종료 요청이 아니다. Linux는 boot ID/PID/startTicks/SID를 확인하고 동일 session의 실행 중 descendant가 사라진 뒤 예약을 해제한다. host 재시작은 명령을 재실행하지 않으며 uncertain owner를 용량에 복원한다. 저장된 identity를 증명할 수 없는 중단 구간이나 setsid/daemon 이탈은 완전한 OS 격리/자동 회수로 주장하지 않는다.
