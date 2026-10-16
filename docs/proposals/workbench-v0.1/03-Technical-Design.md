# 기술 설계 · 상태·API·저장·파일 작업 계약

이 문서의 타입·경로·이벤트 이름은 **새로 제안하는 계약**이다. 현재 코드에 이미 존재한다고 주장하지 않는다. 실제 schema/code 생성은 SDD 단계에서 수행한다.

## 1. 아키텍처 결정

현재 React/TypeScript/Vite·TanStack Router·Zustand·React Flow·Fastify·Coordinator·SQLite·Pi·LangGraph를 유지한다. 전면 재작성이나 실행 엔진 교체는 이번 사용성 개선의 선행 조건이 아니다. [R01, R08–R11]

```text
Studio
  WorkbenchShell / ProjectNav / SessionWorkspace
  Canvas / RunInspector / ReviewWorkspace / Reins
             ↓ commands / queries        ↑ summary feed + run stream
Workbench API & Services
  catalog + sessions + input queue + result queries + review policies
             ↓ validated requests
Coordinator ── LangGraph runner ── Pi adapter/worker
   │                         │
   └─ WorkspaceService / FileOperationService / VerificationService
               │
       safe Git adapter + file broker + approved process host
               │
SQLite: events + projections + commands + immutable versions + effect intents
```

**WorkbenchService는 Task 완료를 새로 결정하지 않는다.** 세션 목록·대기 요청·검토 같은 상위 작업을 관리하고, 실행 상태는 Coordinator의 확정 사실을 따른다. 파일 효과도 동일한 명령 admission과 durable intent를 거친다.

## 2. 데이터 위치: 앱 저장소와 대상 프로젝트를 분리

현재 `<workspace>/.corral/corral.db`라는 저장 구조는 유지 가능한 레거시 저장 위치다. [R09] UI의 Project가 생겼다고 곧바로 프로젝트별 서버·DB를 새로 띄우지 않는다.

첫 도입은 한 설치의 **AppStore DB 하나**에 Project·Session·WorkspaceBinding을 추가한다. AppStoreRoot와 TargetWorkspaceRoot를 코드 타입과 설정에서 분리한다. 기존 `--workspace`가 지정한 데이터 위치는 호환 alias로 읽고 migration 화면에서 설명한다. 새 설치용 `--data-dir`은 별도 옵션으로 제안한다. 사용자 동의 없이 디렉터리를 이동하지 않는다.

WorkspaceBinding은 다른 디렉터리를 가리킬 수 있다. DB가 대상 폴더 아래 있다면 `.corral` 접근을 agent에 명시적으로 거부한다. 더 안전한 app-data 위치로 옮기는 기능은 별도 백업·import 명령이며 원본은 즉시 삭제하지 않는다.

다른 DB를 가진 과거 설치는 live merge하지 않는다. read-only archive 또는 정지 후 import 대상으로 취급한다. repo trust, key, 모델 credential을 archive와 함께 복사하지 않는다.

## 3. 식별자와 버전

- `projectId`, `sessionId`, `workspaceId`, `workspaceEpochId`는 새 영속 ID다.
- `runId`, `executionId`, `taskId`, `modelCallId`, `directiveId`, `artifactVersionId`는 기존 ID를 유지한다.
- `resultRevisionId`, `changeSetRevisionId`, `fileRevisionId`, `snapshotId`, `feedbackBatchId`, `integrationId`는 불변 대상이다.
- 메타정보 변경의 `revision`, Run 제어의 `controlRevision`, Workspace 쓰기의 `generation/fence`는 별도 카운터다.
- `sessionId`라는 기존 인증·backend field를 사용자 작업 Session으로 재사용하지 않는다.

Run snapshot에 팀 revision, 실제 RunInput, context snapshot, workspace epoch, 시작 snapshot, 권한·toolset·모델 snapshot을 포함한다. 실행 도중 Session 기본 팀이 바뀌어도 기존 Run snapshot은 변경하지 않는다.

## 4. 저장 모델과 제약

아래 표는 논리 스키마다. 기존 SQLite `STRICT`, foreign key, numbered migration과 읽기 전용 열람 원칙을 유지한다. 현재 `database.ts`에는 run_events·artifact_texts의 수정/삭제 금지 trigger가 있으므로, 새 기능이 이를 우회해 과거 이벤트를 바꾸지 않는다. [R08]

| 테이블/모델 | 주요 필드 | 제약 |
|---|---|---|
| projects | id, name, defaults, instructionVersionId, revision, archivedAt | 이름과 실제 root를 동일시하지 않음 |
| workspace_bindings | id, projectId, canonicalRootRef, mode, repoIdentity, trust, revision | 경로는 서버 보관; 이동·다른 저장소 감지 |
| work_sessions | id, projectId, title, objective, teamRef, activeEpochId, revision, archivedAt | Project 참조, 과거 Run cascade 삭제 금지 |
| session_entries | id, sessionId, seq, kind, bodyRef, author, refs | Session 내 seq 유일, 저장된 body 불변 |
| session_run_links | sessionId, runId, ordinal, requestId, origin | runId 유일; migration 링크는 별도 origin |
| session_requests | id, sessionId, intent, target, frozenPlan, state, startCommandId | 한 request에서 Run 최대 하나; command hash 재사용 검사 |
| context_snapshots | id, project/session instruction versions, entries, artifact/file refs, hash | 실제 전달 대상과 누락/요약 정책 기록 |
| workspace_epochs | id, sessionId, workspaceId, baselineSnapshotId, lineage | 다른 작업 공간의 net diff를 자동 합치지 않음 |
| workspace_snapshots | id, epochId, manifestHash, capturePolicy, consistency, completeness | 불변; scope/생략 목록 포함 |
| file_revisions | id, workspaceId, relativePath, type, bytesRef, contentHash, mode | 파일 내용 불변; hash는 원본 bytes 기준 |
| change_set_revisions | id, scope, baseSnapshotId, targetSnapshotId, entries, provenance | before/after 존재 또는 absent 표식; 큰 목록 pagination |
| result_revisions | id, runId, summaryRef, artifacts, changesets, verification refs, completeness | 모델 요약과 실행 사실 구분 |
| feedback_batches | id, sessionId, reviewTarget, revision, state, submissionCommandId | 제출한 batch 불변; 후속 수정은 새 revision |
| review_comments | id, batchId, file pair, side/range/contextHash, body, state | 줄 번호만으로 최신 내용에 재부착 금지 |
| verifications | id, runId, snapshotId, command spec hash, environment hash, result | 종료 코드·signal·timeout·stdout/stderr refs 포함 |
| review_decisions | id, changesetRevisionId, criteriaVersionId, actor, decision | approval의 대상은 불변 revision |
| file_operations | id, run/execution refs, expectedBefore, plannedAfter, state, fence | FS 효과 intent; 재시도는 동일 operation key |
| integration_operations | id, approvalId, sourceChangeset, targetManifest, orderedOps, state | 파일별 성공/실패·불명 상태 보존 |
| workbench_event_refs | cursor, domain, eventRef | 전역 UI 요약 feed; 기존 run seq를 대체하지 않음 |
| view_preferences | ownerScope, key, version, value | UI 전용; 실행 정책으로 사용 금지 |

현재 규모에서는 지원 텍스트의 원본 byte blob을 SQLite BLOB으로 저장해 metadata와 동일 transaction에 넣는 방식이 단순하다. 기존 artifact_texts는 유지하고 FileRevision만 별도 byte 저장한다. 기본 파일 크기·총 snapshot 크기·디스크 budget을 두며, 대형 binary object store는 후속이다. chunk dedup/압축은 correctness 이후 최적화다.

contentHash는 SHA-256 등 선택한 algorithm을 명시한다. Git blob OID와 원본 파일 SHA-256을 혼동하지 않는다. mode·파일 존재 여부·경로가 manifest 해시에 포함되어야 한다.

## 5. Session 명령과 Run 시작의 원자성

세션 메시지를 저장하고 Run 시작을 별도 fire-and-forget로 호출하면 응답 유실·재시작 때 고아 메시지 또는 중복 Run이 생길 수 있다.

제안 흐름:

1. 사용자 제출을 commandId와 payload hash로 검증한다.
2. Session request, immutable 입력, start intent를 같은 DB transaction에 기록한다.
3. dispatcher가 기존 Coordinator의 create/start 명령을 **고정 startCommandId**로 호출한다.
4. Coordinator가 새 Run·start command receipt·session_run_link를 같은 저장 transaction에서 기록하도록 RunCreationContext를 확장한다.
5. 시작 실패도 request 상태에 반영한다. 메시지가 사라지지 않는다.
6. 프로세스가 중간에 죽으면 startCommandId로 receipt를 조회해 조정한다. 이미 Run이 있으면 새로 만들지 않는다. 시작하지 않은 유료 대기 요청은 재확인이 필요하다.

실제 transaction 경계는 기존 RunStore 인터페이스를 확장해서 구현한다. 웹 API에서 RunStore 내부 테이블을 직접 바꾸는 우회 경로를 추가하지 않는다.

세션은 여러 개일 수 있지만 U1–U3 기본 실행은 전역 1개를 유지한다. 질문 전용 Run도 이 정책을 따른다. 병렬화는 나중에 global capacity + session active owner + workspace writer lease의 계층으로 확장한다.

## 6. 명령·이벤트·조회 API

새 API의 예시 namespace는 `/api/workbench/v1`이다. 실제 기존 route와의 충돌·인증 처리 방식을 구현 시 검사한다. 아래 이름이 현재 배포 API라는 뜻은 아니다.

| 호출 | 의미 |
|---|---|
| GET /capabilities | schema versions, filesystem/git/verification 지원, 실제/모의 모드 |
| POST /projects | 이름·설명·기본 팀 생성. 로컬 path는 별도 등록 |
| POST /projects/:id/workspaces | 사용자 승인된 경로 등록·canonicalization·trust 검사 |
| POST /projects/:id/sessions | WorkSession 생성 |
| GET /sessions/:id | 메타정보·현재 상태·activeRun/epoch·revision |
| GET /sessions/:id/entries?after=... | 페이지화된 작업 흐름 |
| POST /sessions/:id/requests | intent=continue/steer/queue/explain, scope·expected revisions |
| GET /sessions/:id/results | Run별 ResultRevision 목록 |
| GET /changesets/:revisionId | 파일 metadata·scope·source snapshot·completeness |
| GET /changesets/:revisionId/files/:fileChangeId | before/after refs와 diff view data |
| GET /file-revisions/:id/content | 허용된 불변 내용. 임의 path 읽기 엔드포인트 금지 |
| POST /feedback-batches | version-anchored comments draft/submit |
| POST /review-decisions | changeset+criteria revision에 대한 검토 판단 |
| POST /integration-plans | 반영 대상 현재 상태를 읽고 preview 계획 생성 |
| POST /integrations | 승인한 plan + idempotency key + expected target를 실행 |
| POST /integrations/:id/reversal-plan | 실제 반영 기록으로 역변경 계획 생성 |
| GET /events?after=cursor | Project/Session/attention 요약 feed |

Run pause/cancel/steer는 기존 Coordinator 명령을 감싸되 의미를 바꾸지 않는다. 실제 구현에서 임의의 자연어를 정책 변경 명령으로 즉시 실행하지 않는다.

Command envelope 예시:

```json
{
  "schemaVersion": "workbench/1",
  "commandId": "cmd_example",
  "sessionId": "session_example",
  "intent": "steer",
  "target": {"runId": "run_example", "executionId": "execution_example"},
  "expected": {"sessionRevision": 4, "controlRevision": 19},
  "bodyRef": "entry_example",
  "fallback": "none"
}
```

`202 accepted`는 적용 성공이 아니다. queued/accepted/dispatched/undelivered receipt를 구분한다. stale revision·unknown workspace·unknown file·capability mismatch는 명시적 오류 코드로 반환한다. 모델이 제공한 project/session/workspace ID를 그대로 믿지 않고 서버가 상호 소속을 검사한다.

일반 file path를 URL key로 사용하지 않는다. UTF-8 및 특수문자·case-sensitive 규칙이 다른 OS를 위해 opaque fileChangeId와 server-owned relative path metadata를 쓴다.

## 7. 새로운 이벤트 그룹

| 그룹 | 제안 이벤트 | 주의 |
|---|---|---|
| catalog | project.created, workspace.registered, session.created, session.archived | Run 이벤트와 별도 domain |
| request | session.request.accepted, queued, started, rejected, needs_confirmation | 하나의 request와 Run 링크를 추적 |
| snapshot | workspace.snapshot.captured, invalidated | 일관성·scope·생략 정보를 기록 |
| file | file.operation.planned, dispatched, observed, reconciled, conflict, uncertain | 시작 이벤트를 성공으로 보지 않음 |
| change | changeset.created, result.revision_created | 변경 가능한 draft와 불변 revision 분리 |
| review | feedback.submitted, dispatched, obsolete, review.recorded, verification.stale | 검토 읽음과 승인은 별도 |
| integration | integration.planned, started, partial, completed, failed, uncertain | multi-file atomicity를 약속하지 않음 |

이름 확정 후 기존 events union과 JSON Schema·version handler·projection 테스트를 함께 변경한다. 오래된 reader가 모르는 제어 이벤트를 무시한 채 완료로 표시하지 않도록 capabilities handshake를 둔다.

전역 feed cursor와 run seq는 다른 것이다. 한 transaction의 확정 이벤트에서 outbox/reference를 만들고, summary projection이 뒤처지면 cursor를 기준으로 다시 따라간다. 상세 화면은 기존 Run 이벤트를 계속 사용한다. UI용 feed가 별도의 실행 진실 원천이 되어서는 안 된다.

재접속은 `(snapshot, cursor)`를 동일 시점 기준으로 받고 그 이후를 이어 받는 계약이 필요하다. gap 또는 보관 범위를 벗어나면 snapshot reset을 요구한다. live token frames는 유실 가능 표시가 있는 임시 정보이며 durable 이벤트를 대신하지 않는다.

## 8. 파일 스냅샷과 diff 계산

### 8.1 기준 수집

지원 파일 목록과 정책을 고정하고 전후 scan의 path/type/size/hash 등을 확인한다. Corral write lease를 잡아 관리된 쓰기를 정지한다. 외부 변경이 관측되면 재시도하거나 `unstable`로 표시한다. 단순 두 번 스캔이나 watcher는 비협조적 외부 프로세스에 대한 OS 원자 snapshot을 증명하지 않는다. 그 보장을 필요로 하면 filesystem snapshot/OS 격리를 추가하거나 기능을 제한한다.

원본 저장소의 HEAD, index, working tree는 서로 다르다. staged/unstaged 비교는 별도 scope다. untracked는 `git diff`만으로 포괄된다고 가정하지 않고 명시적으로 수집한다. tracked 여부와 snapshot 포함 여부를 분리한다.

과거 세션의 baseline이 없다면 `기준 없음`이다. 현재 HEAD를 과거 baseline으로 만들어 넣지 않는다. 삭제됐거나 unavailable인 bytes도 빈 문자열과 구분한다.

### 8.2 native Git 사용

Git CLI를 서버의 제한된 어댑터로 호출한다. shell 문자열 연결 없이 argv를 사용하며 저장소·범위는 서버에서 resolve한다. status/worktree 출력은 `--porcelain`과 가능한 `-z` 구조를 파싱한다. diff에서는 외부 helper·textconv·pager를 비활성화하고 repo config를 신뢰하지 않는다. literal pathspec과 `--`를 적절히 사용한다. [S01, S02]

Git 설정·hooks·filter는 실행 가능 코드일 수 있다. 특히 worktree checkout이나 test 명령 전에 trusted repository 승인을 요구한다. 이 문서의 flag 목록이 모든 외부 실행을 차단하는 완전한 샌드박스라고 주장하지 않는다.

문서/비Git 결과의 diff는 저장한 원본 bytes의 text view로 만든다. Git가 보여주는 raw repository 상태와 Corral managed operation 기록을 서로 대체하지 않는다.

### 8.3 UI 데이터와 의미

파일 목록 metadata를 먼저 조회하고 선택 파일의 두 내용을 lazy load한다. 통합/나란히 diff는 view preference다. 검토 승인 기준은 표시 줄번호가 아니라 불변 파일·changeset hash다. raw bytes는 보존하고 표시상 EOL 정규화 여부를 안내한다.

rename provenance는 관리된 move operation과 Git 유사도 추정을 구분한다. binary 변경은 text diff를 강제로 만들지 않는다. 부분 snapshot의 file count를 전체 repository 변경 수처럼 표시하지 않는다.

## 9. 관리된 파일 작업 프로토콜

첫 구현에서는 agent가 root filesystem API나 native coding-agent의 unrestricted bash를 직접 받지 않는다. 협업 tool은 기존 admission으로, file tool은 WorkspaceService를 통한 검증된 요청으로 제공한다.

```text
요청 → scope/permission 검사 → workspace lease/fence 확인
    → before bytes/hash/type/mode 확인
    → plan과 before/after bytes를 durable intent로 기록
    → 효과 직전 권한·취소·fence 재검사
    → 지원 파일 작업 수행
    → after 상태 재확인
    → 성공/충돌/실패/불명 outcome 기록
    → 결과·스냅샷 갱신
```

`planned → dispatched → applied | failed | uncertain`이 기본 효과 상태다. permission 거부는 dispatched 전에 기록한다. `cancel_requested`가 먼저 확정됐다면 신규 file effect를 dispatch하지 않는다. 이미 효과가 발생한 뒤 취소됐으면 '취소됐지만 변경 남음'이 가능하다.

SQLite와 대상 filesystem은 한 transaction이 아니다. 앱이 intent 기록 후 죽었다면 복구 시 before/after와 실제 파일을 대조한다. 실제 bytes가 planned after와 같아도 다른 프로세스가 같은 내용을 썼을 가능성이 있으므로 `after-state observed/reconciled`를 정확한 actor 증명으로 바꾸지 않는다. 어느 쪽도 아니면 uncertain이고 사용자 확인 전 자동 재실행/되돌리기를 막는다.

파일 rename은 플랫폼별 atomic replace 가능 조건을 확인한다. 여러 파일·이동·삭제 전체에 대해 atomic rollback을 약속하지 않는다. 강제 kill·디스크 full·권한 변경·symlink swap·partial write를 테스트한다.

### 중요: CAS의 한계

`읽어서 hash 비교 후 rename`은 외부 편집기와 원자적인 compare-and-swap이 아니다. Corral 내부 actor는 write lease로 직렬화할 수 있지만 비협조적 외부 writer는 따르지 않는다. 초기 공식 쓰기 범위를 앱이 관리하는 별도 worktree로 제한하고, 외부 변경 감지 시 동작을 보류한다. 강한 격리를 보장하지 못하는 모드는 그 사실을 표시한다.

## 10. 경로·실행 보안

WorkspaceID는 서버가 선택된 실제 root로 resolve한다. agent는 `relativePath`만 요청한다. parent traversal, 절대 경로, UNC/device path, .git/.corral/credential 경로, symlink/junction 탈출, case-fold 충돌, special file을 거부한다. 플랫폼별 실제 파일 핸들과 경로 정책을 검증한다. `startsWith(root)` 문자열 검사만 사용하지 않는다.

Worktree 생성에는 사용자가 승인한 저장소와 명시한 base commit만 쓴다. remote fetch·submodule update·dependency install은 자동 실행하지 않는다. Git safe.directory를 전역 `*`로 바꾸지 않는다. 비밀정보 환경변수는 worker/검증 프로세스에 기본 전달하지 않는다.

검증 프로세스는 `executable + argv + cwd + env allowlist + timeout`으로 등록한다. project script는 임의 코드를 실행할 수 있으므로 사용자 trust가 필요하고, process child/grandchild 정리가 검증되어야 한다. '테스트 preset만 허용'을 OS 보안 경계로 설명하지 않는다.

## 11. 검증·승인·반영의 상태 계약

검증은 snapshotHash, 포함/제외 파일 manifest, 의존성/lockfile·toolchain·환경 fingerprint, command spec, stdout/stderr refs, exit/signal/timeout, 시작/끝 시간을 저장한다.

검증 중 파일이 달라졌으면 결과를 고정 snapshot의 통과로 확정하지 않는다. `unstable_input` 또는 구체적 검증 범위를 표시한다. coverage 범위와 '실행 안 함'도 명시한다. 환경 fingerprint에 secret value를 넣지 않는다.

승인은 `(changeSetRevisionId, criteriaVersionId, requiredVerificationIds)`에 고정한다. 단순 file viewed는 승인과 별도다. 새 revision에서도 같은 파일이면 읽음 표시는 이전했음을 표시하며 재사용 가능하지만, 전체 승인·검증은 무조건 승계하지 않는다.

IntegrationPlan은 source changeset hash, target workspace/revision, 파일별 expected before/planned after, 삭제·이동·불가 항목을 가진다. 실행 버튼 전 대상과 범위를 보여준다. plan 이후 target이 바뀌면 409 충돌·재계획이 기본이며 force 옵션은 초기 범위 밖이다.

여러 파일 중 일부가 반영됐으면 `partial`과 파일별 결과를 보여준다. 자동으로 성공이라고 합치거나 계획 전체를 재시도하지 않는다. ReversalPlan은 **실제 반영된 operation**만 역변경한다. 이후 사용자 수정은 검사 후 충돌로 처리한다. commit·push는 독립 명령이며 자동으로 포함하지 않는다.

## 12. 프런트엔드 상태·라우트·캐시

제안 route:

```text
/projects
/projects/:projectId/sessions/:sessionId
/projects/:projectId/sessions/:sessionId/team
/projects/:projectId/sessions/:sessionId/runs/:runId
/projects/:projectId/sessions/:sessionId/review/:changeSetRevisionId
/attention
/teams
/settings/models
```

기존 `/runs/:runId`, `/corrals/:corralId/edit`, `/compare`, `/demo`는 호환 링크로 유지한다. legacy run에 session mapping이 있으면 새 화면으로 연결하되 execution/artifact query를 보존한다. 로컬 절대 경로·비밀정보를 route query로 넣지 않는다.

Store 분리:

- ProjectCatalog/SessionIndex: 목록과 metadata.
- SessionConversation: durable entries·request queue; 상세 Run raw event를 전부 복사하지 않음.
- RunViewStore: 기존 projection·receipts·stream.
- CanvasDraftStore: 현재 편집중인 정의/layout·undo.
- ReviewStore: immutable compare refs + 미제출 의견 + 선택 file.
- UIState: layout/scroll/active panel.

Monaco model URI는 세션의 실제 절대 path가 아니라 불변 version을 반영하는 내부 URI다. 같은 path의 다른 Run 내용이 한 model을 덮어쓰지 않게 한다. 열린 compare만 두 model을 만들고 해제/제한된 LRU를 운영한다. raw 내용 저장과 editor view state를 분리한다. [S03]

## 13. 라이브러리 선택

| 영역 | 선택 | 근거·범위 |
|---|---|---|
| Router·Canvas·state | 현재 TanStack Router, React Flow, Zustand 유지 | 저장소에 이미 있음. 이번 개선 때문에 major upgrade하지 않음 [R10] |
| 리스트 가상화 | 현재 @tanstack/react-virtual 재사용 | packages/react에 이미 있음 [R11] |
| Markdown·i18n·테스트 | 현재 react-markdown, use-intl, Vitest/Playwright/Storybook 유지 | 기존 접근성·locale·mock 인프라 유지 [R11] |
| Diff 표시 | **monaco-editor**를 desktop review route에 lazy import | 공식 model/URI/dispose 개념 활용. 자체 React wrapper로 범위를 제한; VS Code plugin host가 아님 [S03, S04] |
| 패널 조절 | **react-resizable-panels** | resize·keyboard separator·layout 저장. 도입 시 현재 API 명칭을 고정하고 wrapper로 캡슐화 [S05] |
| Git | 설치된 native Git + 제한된 node child_process 어댑터 | 별도 Git 전체 구현을 피함. 버전/capabilities 확인, 명령·출력 상한 [S01, S02] |
| 파일 관측 | bounded rescan + event-driven invalidation | watcher는 변경 힌트일 뿐 author/원자성 보장이 아님. 필요한 OS에서만 watcher dependency를 추가 검토 |
| 저장 | 기존 better-sqlite3·numbered SQL migration 유지 | ORM 교체를 이번 범위에 넣지 않음 [R08] |

신규 외부 dependency는 우선 Monaco와 panel 두 개로 제한한다. Monaco와 panel의 라이선스는 공식 저장소 기준 MIT다. 활동성과 정확 버전·Node/peer 호환성·CSP/worker 구성은 도입 PR에서 다시 확인해 lock한다. 최신이라는 이유만으로 upgrade하지 않는다. 웹 문서 조회는 설치·통합·보안 검증과 다르다.

Monaco assets/workers는 앱과 함께 제공하고 CDN으로 사용자 코드를 보내지 않는다. 모바일은 read-only 텍스트 fallback을 제공한다. xterm, Electron/Tauri, full LSP, CRDT, Redis, 독립 검색 서버는 이번 선행 의존성이 아니다.

## 14. 마이그레이션과 삭제

### additive migration

현재 DB에 새 table과 versioned reader를 추가한다. 기존 run_events와 artifact_texts는 원문 유지한다. 기존 Run 하나당 기본 Session 하나를 만들고 `origin=legacy_import`로 mapping한다. `startedFrom` 관계는 부모 링크로 유지하되 동일 작업이라는 사용자 의도까지 추정하지 않는다.

기존 Project는 '기존 작업'이라는 이름으로 생성할 수 있지만, 현재 data root를 모델이 수정해도 되는 target workspace로 자동 승인하지 않는다. 사용자가 별도 연결해야 한다. 과거 Run에는 실제 파일 baseline이 없으므로 diff는 unavailable이다.

원래 CorralDefinition의 input을 새 팀 definition과 입력 기본값으로 해석하는 legacy adapter를 둔다. 과거 hash나 snapshot을 재계산해 덮지 않는다. 새 filesystem tool을 포함한 정의는 schema version을 명시하고 구버전에서 실행 거절되게 한다.

migration은 백업 + 쓰기 프로세스 정지/독점 + dry-run 요약 + transaction + consistency 검사 순서다. WAL 사용 DB를 실행 중 파일 copy 한 번으로 백업했다고 가정하지 않는다. rollback은 검증된 백업 복원이며 새 사용자 데이터의 조용한 손실을 허용하지 않는다.

### 삭제

보관·workspace 제거·Session 영구 삭제를 독립 작업으로 둔다. 기존 append-only trigger 때문에 generic cascade로 처리하지 않는다. 영구 삭제는 maintenance mode에서 선택한 데이터 참조를 재구성·검증하는 별도 기능이며, 그 전 단계에는 archive만 제공한다. 참조하는 다른 Session이 있으면 차단 또는 scope 확장 확인을 요구한다. 백업과 사용자가 export한 사본까지 지워진다고 약속하지 않는다.

## 15. 불변식

1. 한 SessionRequest는 Run을 최대 하나 만든다.
2. 종료 Run/기존 Artifact/기존 Event를 후속 요청이 덮어쓰지 않는다.
3. 업무 Session 선택이 backend worker 취소가 되어서는 안 된다.
4. actor 식별이 없는 변경은 agent 작성으로 표시하지 않는다.
5. FileRevision의 raw bytes·mode가 바뀌면 새 ID를 만든다.
6. 프로젝트 수정은 허용된 workspace+operation 경로만 통과한다.
7. 취소 후 이미 적용된 파일은 자동으로 사라지지 않는다.
8. 승인된 target revision과 다른 대상에는 같은 승인을 사용하지 않는다.
9. Run 완료는 검증·반영·commit 완료를 뜻하지 않는다.
10. unresolved file effect가 있으면 동일 workspace의 신규 쓰기를 막는다.
11. view의 이전 revision을 보고 작성한 피드백은 최신 것으로 조용히 취급하지 않는다.
12. UI pending 성공 추정으로 durable 상태를 덮어쓰지 않는다.
