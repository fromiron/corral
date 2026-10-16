# SDD·TDD 구현 플랜

상태: 예정 작업. 기존 코드 변경·PR·테스트 실행 결과가 아니다. 기존 AGENTS.md의 요구/태스크/테스트 추적, 명세 변경 요청, 유료 live opt-in 규칙을 유지한다. [R13]

## 1. 개발 전략

전면 재작성 대신 기존 Coordinator·RunEvent·Pi·RunCanvas·Reins·ArtifactViewer를 재사용한다. 변경은 Session 상위 단위와 Workspace 파일 효과 경계를 추가하는 방식이다.

프런트엔드 작업을 마지막으로 미루지 않는다. 첫 PR 묶음부터 프로젝트·세션·복수 결과·Reins의 상태를 모의 데이터로 조작할 수 있어야 한다. 모의 UI가 데이터 계약을 마음대로 만든 뒤 백엔드를 맞추는 방식도 피한다. 상태·명령·수용 조건을 같은 feature spec으로 연결한다.

## 2. 단계별 제공 기준

| 단계 | 사용자 가치 | Release gate |
|---|---|---|
| U0 | 새 작업 흐름을 실제 UI에서 검토 | mock interaction·계약 검토. 실파일 미지원 표시 |
| U1 | 프로젝트·세션을 찾고 이전 작업을 이어감 | 실 저장·후속 Run·다중 결과·기존 링크·D&D·Reins 회귀 |
| U2 | 격리 복사본에서 여러 파일 작업 | baseline·권한·intent·실제 diff·검증·취소·불명 작업 차단 |
| U3 | 의견→수정→검증→원본 반영의 끝까지 | versioned review·충돌·부분 실패·역변경·privacy·성능·지원 OS gate |

U1을 먼저 제공하더라도 U2/U3를 없애지 않는다. 상용 수준이라는 목표는 필요한 실패 계약을 완성하는 것으로 판단한다. 코딩 기능을 먼저 켜놓고 보안·reconciliation은 나중에 추가하지 않는다.

## 3. 첫 세 PR 묶음

### PR-A: 계약 + 새 Shell + 다중 출력

WBT-01/02와 WBT-08의 기존 이벤트를 읽는 UI 부분. Project/Session은 mock과 feature flag로 연결하고, 현재 Run의 모든 output artifact를 열 수 있게 한다. 실패·취소 partial 결과, 기존 Canvas·Reins 접근을 보여준다. 새 schema로 기존 결과를 대량 변환하지 않는다.

테스트부터: output artifact가 3개인 fixture에서 첫 항목만 보이면 실패, terminal failure에서도 생성 artifact는 남음, 작업/팀 탭 왕복으로 선택이 보존됨.

### PR-B: 영속 Project/Session + legacy mapping

WBT-03/04/07/10을 작은 dependency PR로 나눈다. 기존 DB backup/upgrade/read compatibility를 검사한다. CLI의 기존 data root를 실제 coding root로 자동 승인하지 않는다.

테스트부터: 같은 이름의 프로젝트를 ID로 구분, 폴더 없는 Session, archive는 파일 삭제가 아님, 원래 Run deep link가 새 Session에서 동일 결과로 열림.

### PR-C: 후속 입력 + 맥락 + Run 시작

WBT-05/06/09/11. 메시지 저장·queue·start intent·RunLink·receipt를 연결한다. 응답을 잃은 재시도에서 새 Run이 하나만 생기는지 검사한다. 새 입력 때문에 과거 brief/context를 바꾸지 않는다.

이후 실제 파일 도구 전에 read-only Git/snapshot/diff를 완성한다. 그 다음 Workspace intent·permission 테스트를 통과한 managed write를 연다.

## 4. SDD 산출물

feature별 문서는 `specs/workbench-upgrade/<feature>/`를 제안한다. 기존 specs 번호를 덮어쓰지 않는다.

- `spec.md`: 사용 목적, 범위·비범위, 상태·오류, REQ ID, 사용자 수용 기준.
- `design.md`: 현재 코드 경로와 제안 변경, 계약, migration, 보안·장애.
- `test-plan.md`: 아래 test-cases.json의 시나리오와 mock/live 분리.
- `evidence.md`: 실행 환경·커밋·명령·성공/실패·미실행·알려진 한계.

feature는 `catalog-session`, `session-dispatch`, `result-bundle`, `workspace-snapshot`, `managed-file-effects`, `review-reins`, `integration`, `release-quality`로 나눈다. CLI·UI·API가 다른 의미의 동일 명령을 만들지 않도록 공유 계약이 먼저다.

## 5. TDD 순서

Given/When/Then을 확정하고 원하는 실패를 재현한다. 그 뒤 가장 작은 구현으로 통과시킨다. 리팩터링 후 정상·취소·중복·late event 회귀를 실행한다. 변경된 문서·schema·fixture·증거를 같은 PR에 넣는다.

1. 순수 계약/상태 함수: Context 선택, 비교 범위, approval validity, command dedup.
2. 저장 통합: SQLite tx/unique constraint/rollback/legacy import.
3. 효과 통합: 파일 temp dir·fake Git/process·fault injection·expected hash·uncertain reconciliation.
4. 컴포넌트: Session/Result/Reins/Diff의 상태별 Storybook·Testing Library.
5. E2E: mock runtime 기반 결정적 사용자 경로.
6. opt-in live: 실제 모델→managed file→검증. 유료 상한·workspace 제한·environment 기록.

Mock을 통과했다고 LLM이 의미적으로 지시를 충족한다고 주장하지 않는다. 실제 모델 출력도 versioned verification/review로 평가한다.

## 6. 병렬 구현 규칙

한 명이 개발할 때도 backend 계약·frontend interaction을 수직 단위로 연결한다. 여러 개발 에이전트를 쓴다면 contracts/database/coordinator는 한 소유자를 두고, UI와 test fixture는 승인한 interface 뒤에서 나눈다.

권하는 작업 분담은 계약/저장, UI/접근성, workspace/Git, 테스트/반례 네 영역이다. 모든 에이전트에게 repo unrestricted write를 열어 동시에 같은 core 파일을 수정하게 하지 않는다. 각 작업은 자신의 REQ/테스트/변경 허용 경로를 명시한다.

## 7. 공수 관리

S/M/L은 상대 크기이며 일정 약속이 아니다. L은 여러 상태 경계 또는 실제 파일 효과가 포함된 작업이다. 첫 스파이크에서 schema·새 UI·Git snapshot·Pi file binding의 실측 구현 시간을 기록한 후 추정한다. 지금 상용 수준 전체를 2~3주로 확정하지 않는다.

작업이 커졌을 때 먼저 줄일 후보: hunk 적용, multi-worktree 병렬, source editor, 원격 PR, 실시간 앱 preview 서버. 줄이지 않을 것: D&D, Session 지속성, 실제 변경 근거, Reins 전달 확인, 취소/변경 잔존 표시, 기존 데이터 보호.

## 8. 태스크 목록

| ID | 단계 | 작업 | 크기 | 선행 | 완료 조건 |
|---|---|---|---|---|---|
| WBT-01 | U0 | 기준 커밋·CR·계약 잠금 | S | — | 현재 baseline과 기존 규칙을 기록하고 변경범위·feature spec·불변식을 승인한다. |
| WBT-02 | U0 | WorkbenchShell 모의 세로 슬라이스 | M | WBT-01 | 프로젝트·세션 전환, 기존 Canvas 진입, 복수 결과, Reins 접수·미전달 상태를 클릭 가능한 fixture로 만든다. |
| WBT-03 | U1 | AppStore schema와 repository | M | WBT-01 | Project/WorkSession/WorkspaceBinding/SessionEntry/RunLink 및 versioned migration을 추가한다. |
| WBT-04 | U1 | Project·Session 서비스와 API | M | WBT-03 | 생성·목록·검색·고정·보관·팀 선택과 null workspace를 지원한다. |
| WBT-05 | U1 | RunInput·ContextSnapshot 분리 | M | WBT-03 | 재사용 팀과 Run 요청을 분리하고 legacy input 변환·지침 선택·피드백 참조를 구현한다. |
| WBT-06 | U1 | 후속 요청·대기열·멱등 시작 | L | WBT-04, WBT-05 | SessionRequest→start intent→Coordinator→RunLink가 응답 유실에도 중복 Run을 만들지 않게 한다. |
| WBT-07 | U1 | 프로젝트 탐색·세션 라우트 | M | WBT-02, WBT-04 | 새 라우트·세션 제목·핀·보관·검색과 팀 설계를 연결하고 기존 deep link를 보존한다. |
| WBT-08 | U1 | 다중 결과·부분 결과 | M | WBT-03 | 첫 artifact 선택을 제거하고 output 전체/중간 artifacts/실패 결과를 ResultRevision 투영으로 제공한다. |
| WBT-09 | U1 | Session 작업 흐름·Composer | M | WBT-06, WBT-07, WBT-08 | 실행 카드·후속 요청·target chip·queue/explain·초안 보존과 Reins receipt를 연결한다. |
| WBT-10 | U1 | 과거 데이터 이관·호환 reader | M | WBT-03, WBT-07, WBT-08 | 기존 ID·이벤트를 보존하며 1 Run→1 Session을 기본 이관하고 기준 없는 diff를 unavailable로 표시한다. |
| WBT-11 | U1 | Store 분리·요약 feed·재접속 | L | WBT-06, WBT-07 | RunViewStore 명칭/구독을 정리하고 프로젝트 summary feed와 cursor 기반 재접속을 추가한다. |
| WBT-12 | U2 | Workspace·안전한 Git 조회 | M | WBT-04 | 등록 root·trust·Git capabilities와 status/HEAD/index/untracked 조회를 제한된 argv 경로로 제공한다. |
| WBT-13 | U2 | 불변 파일 revision·snapshot | L | WBT-12, WBT-03 | raw bytes·mode·include/exclude·생략/unstable 정보를 저장하고 과거 비교를 재현한다. |
| WBT-14 | U2 | ChangeSet 범위·출처·집계 | L | WBT-13, WBT-08 | Run/Session epoch/review/Git scope를 계산하고 관측과 관리된 변경을 구분한다. |
| WBT-15 | U2 | 검토 화면·Diff adapter | M | WBT-14, WBT-02 | Monaco lazy route·파일 tree·통합/나란히 diff·모델 해제·대형/바이너리 fallback을 구현한다. |
| WBT-16 | U2 | 격리 작업 복사본 생명주기 | L | WBT-12, WBT-13 | 기준 commit·dirty 제외 확인·managed worktree 생성·재연결·안전한 제거 guard를 구현한다. |
| WBT-17 | U2 | 파일 효과 intent·reconciliation | L | WBT-13 | planned/dispatched/outcome, before/after 보존, 중간 종료·디스크 실패의 uncertain 처리를 구현한다. |
| WBT-18 | U2 | 경로·파일 쓰기 정책 | L | WBT-16, WBT-17 | workspace lease·expected hash·취소 fence·경로 탈출 방지와 add/edit/delete/move를 구현한다. |
| WBT-19 | U2 | Pi 파일 도구 연결 | M | WBT-18, WBT-14 | 관리된 파일 도구만 Pi에 노출하고 실제 operation과 run/execution/task/request를 연결한다. |
| WBT-20 | U2 | 동의한 검증 명령·결과 | L | WBT-19 | trusted project 명령 preset·환경·timeout·프로세스 종료·snapshot 검증을 기록한다. |
| WBT-21 | U3 | 버전 고정 review comments | M | WBT-15 | side/range/before/after snapshot에 의견을 고정하고 draft/obsolete 상태를 표시한다. |
| WBT-22 | U3 | FeedbackBatch→Reins·후속 Run | L | WBT-21, WBT-09, WBT-19 | 일괄 제출·명시 target·safe boundary·종료 경합·새 수정 Run과 directive lineage를 연결한다. |
| WBT-23 | U3 | 검토·검증 validity | M | WBT-20, WBT-21 | 읽음·approval·verification을 분리하고 기준/파일/환경 변경 후 stale 정책을 적용한다. |
| WBT-24 | U3 | 원본 반영 계획 | M | WBT-23, WBT-18 | 정확한 source/target snapshot·승인 버전·파일별 작업 preview와 충돌 검사를 구현한다. |
| WBT-25 | U3 | 반영·역변경·중간 실패 | L | WBT-24, WBT-17 | 파일별 durable outcome과 partial/uncertain을 보존하고 실제 반영분만 역계획한다. |
| WBT-26 | U3 | 확인 필요 Inbox | M | WBT-11, WBT-22, WBT-23, WBT-25 | 질문·승인·충돌·불명 작업·재검토를 source revision에 연결하고 처리 명령 결과로 닫는다. |
| WBT-27 | U2 | 산출물·HTML 안전 미리보기 | M | WBT-08, WBT-15 | raw HTML/외부 image 차단, script-disabled preview와 MIME별 fallback을 구현한다. |
| WBT-28 | U3 | 보관·제거·삭제·export 계약 | L | WBT-10, WBT-16, WBT-25 | archive와 cleanup/erasure를 분리하고 참조·미반영 변경·백업 안내·secret 제외 export를 구현한다. |
| WBT-29 | U3 | 성능·접근성·한국어 입력 | M | WBT-09, WBT-15, WBT-22, WBT-26 | 대표 fixture의 전환·diff·메모리·keyboard·IME·screen reader 동작을 측정/수정한다. |
| WBT-30 | U3 | 비밀정보 없는 공개 데모 | M | WBT-22, WBT-23, WBT-29 | 프로젝트·세션·다중 diff·스티어링·실패/취소 모의 흐름을 실제 UI에서 제공한다. |
| WBT-31 | U3 | 통합·이관·장애 테스트 | L | WBT-25, WBT-28, WBT-29 | 리뷰·새 Run·취소·복구·기존 DB·여러 OS 경합 시나리오를 실행해 증거를 수집한다. |
| WBT-32 | U3 | 출시 gate·지원 범위 문서 | M | WBT-30, WBT-31, WBT-27 | 실제 지원/미지원·알려진 한계·data recovery·dependency lock·실측 결과를 공개한다. |

## 9. 현재 코드의 수정 경계

| 현재 경로 | 보존할 것 | 바꿀 것 |
|---|---|---|
| `apps/studio/src/router.tsx` | 기존 Run/Corral/demo deep link | Project/Session/review route와 호환 이동 |
| `pages/WorkspacePage.tsx` | 기존 팀 목록·생성·가져오기 동작 | 팀 라이브러리로 분리, 기본 홈은 프로젝트·세션 |
| `pages/RunPage.tsx` | RunCanvas·ExecutionTree·Reins·상세 동작 | Session 하위 실행 상세로 사용; 기본 대화/결과 화면 분리 |
| `components/RunView.tsx / run/session.ts` | 서버 확정 상태·receipt·safe Markdown | 단일 outputText 의존을 ResultView로 분리, RunViewStore 명칭 |
| `components/ArtifactViewer.tsx` | 불변 artifact·diff·directive lineage | Result registry와 연결; repository file diff와 혼동 금지 |
| `contracts/src/definition.ts` | 기존 snapshot/schema reader | RunInput 분리 adapter·새 파일 tool 계약 version |
| `core/src/coordinator.ts` | single decision path·effect intent·dedup·budget | Session RunCreationContext·Workspace effect hooks; 별도 상태 주인 금지 |
| `storage-sqlite/src/database.ts` | STRICT/foreign keys/migration/history immutability | 새 테이블·additive mapping·retention maintenance |
| `apps/server/src/workspace.ts` | 기존 데이터 위치 호환 | AppStoreRoot와 TargetWorkspaceRoot 구분 |

## 10. Definition of Done

해당 REQ와 test가 연결되고, failure가 실제로 관측된 뒤 통과했으며, UI는 pending/unknown/partial을 구분한다. 기존 D&D/Reins/Run export/import 회귀가 통과한다. migration은 원본 백업과 legacy fixture로 검증한다. library version/license/compat를 기록한다. 모의 결과와 live 증거를 섞지 않는다. 스크린샷만으로 동작 증거를 대체하지 않는다.

출시 blocker: 사용자 변경 무단 덮어쓰기, 뒤늦게 다른 세션에 지시 전달, 동일 request의 중복 Run/반영, 파일 효과 불명 상태에서 자동 재시도, 과거 diff 조작, 취소를 rollback으로 표시, untrusted HTML 실행, 경로 탈출, 사라진 D&D 또는 Reins.
