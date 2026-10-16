# Corral Workbench 개선안 v0.1

프로젝트·세션 · 결과 집합 · 파일 diff · 검토/Reins · SDD/TDD 구현 계획

기준: `a9ecda50175e614fe1f559152dd1974e016883e8` · 2026-10-16 · 제안/미구현

요구사항 40개 / 구현 태스크 32개 / 계획 테스트 56개. 제품 테스트 실행 결과가 아니다.


---

# Corral Workbench 개선 명세 v0.1

상태: **검토·구현 준비용 제안**. 기존 저장소에 적용·커밋하지 않았다. 작성일: 2026-10-16.
기준: `fromiron/corral@a9ecda50175e614fe1f559152dd1974e016883e8`.
이 문서는 새 제품명을 제안하는 것이 아니다. UI 제품명은 **Corral Studio**, Workbench는 이번 개선 묶음의 이름이다.

## 1. 목적과 근거의 구분

**목적:** 하네스를 한 번 실행하는 화면을, 프로젝트의 일을 지속해서 수행·검토·조율하는 작업 공간으로 확장한다.

보존할 핵심은 D&D, 제한된 자율 협업, Loop, 서브에이전트, Reins, 명령·이벤트 기반 실행 제어다. 이를 채팅 앱으로 대체하지 않는다.

- **현재 구현 사실:** Run 출력은 첫 artifact의 본문을 중심으로 렌더링한다. ArtifactViewer의 버전 비교와 인과 표시는 이미 존재한다. 홈·라우트는 정의와 Run 중심이다. 작업 도구는 조사·문서·산출물 중심이다. [R02–R07]
- **기존 합의:** D&D는 제외하지 않는다. 실행 중 구조를 몰래 변경하지 않는다. 개입은 명시적으로 기록하고 앞방향으로만 적용한다. [F01]
- **본안의 새 제안:** Project/Session/Workspace, 파일 변경 집합, diff 피드백, 실제 코딩·검증·원본 반영을 단계적으로 도입한다. 이는 기존 MVP에서 제외했던 파일 쓰기를 후속 범위로 여는 변경이다.
- **미검증:** 실제 앱 사용성, 통합 호환성, 성능 목표, 코딩 작업의 품질·비용 개선. 이 문서는 코드·문서 검토와 설계 판단에 기반한다.

단순히 기존 `Output` 탭을 `Diff`로 바꾸거나, 모든 결과를 Git patch로 통일하지 않는다.

## 2. 성공 경험

사용자가 프로젝트를 열고 이전 세션에서 후속 요청을 한다. 팀과 작업 폴더가 명확히 보인다. 에이전트가 여러 파일을 수정하면 실제 변경과 테스트 결과를 확인한다. 특정 diff에 의견을 남겨 Reins로 전달하거나 후속 수정 Run을 시작한다. 새 결과가 이전 의견을 다뤘는지 확인하고, 승인한 변경만 대상 작업 폴더에 반영한다. 과정에서 D&D와 실행 트리로 팀의 구조·책임·대기 원인을 확인할 수 있다.

문서 조사 세션에서는 동일한 틀 안에서 문서·근거·검토 결과가 주 결과가 된다. Git 저장소 없이도 작업할 수 있다.

## 3. 용어와 책임

| 용어 | 의미 | UI 노출 |
|---|---|---|
| Project | 관련 세션·지침·자료·기본 팀·작업 공간을 묶는 단위 | 사이드바·헤더 |
| Session (`WorkSession`) | 하나의 목적을 이어가는 요청·결정·피드백·Run 이력 | 사이드바의 주요 항목 |
| Run | 고정된 입력·팀 버전·정책으로 시작한 실행 한 번 | 작업 흐름의 실행 카드 |
| Corral / Team Definition | 역할·연결·Loop·도구·한도를 정한 수행 방법 | 팀 설계·팀 선택 |
| WorkspaceBinding | 실제 디렉터리·저장소·작업 복사본과 접근 권한 | 헤더·설정 |
| WorkspaceEpoch | 세션에서 동일한 작업 공간 계보와 기준을 사용하는 구간 | 비교 범위 상세 |
| Execution | 역할 수행의 실제 인스턴스·재시도·자식 실행 | 실행 상세 |
| ResultRevision | 요약·산출물·변경·검증·미해결 항목의 불변 묶음 | 결과 화면 |
| ChangeSetRevision | 고정한 두 상태 사이의 변경 목록 | 변경 검토 |
| Reins | 실행 대상·적용 시점이 드러나는 개입 기능 | 작업·팀·diff에서 접근 |

`RunSessionStore`는 새 영속 Session과 다르므로 `RunViewStore`로 명확히 이름을 바꾼다. 인증 세션은 `AuthSession`, 백엔드 생명주기는 `BackendInstance`로 구분한다. [R04]

Project는 폴더와 동일하지 않다. 첫 구현은 프로젝트당 기본 저장소 하나·세션당 활성 작업 공간 하나를 지원한다. 향후 확장을 위해 연결은 ID로 참조한다. 폴더 없는 프로젝트의 Workspace는 null이다.

## 4. 범위와 전달 단계

| 단계 | 제공 범위 | 제공하지 않는 것 |
|---|---|---|
| U0 · 계약과 화면 | 요구·변경요청, 모의 Project/Session 화면, D&D 유지, Result·Reins interaction | 실제 파일 수정 |
| U1 · 지속 작업 | 영속 Project/Session, 후속 Run, 다중 산출물, 새 탐색 구조, 과거 이관, 입력 의도 | 파일 수정 기능이 있다고 표시하지 않음 |
| U2 · 코딩 베타 | 기존 폴더 읽기 전용 관측, 불변 파일 버전, 별도 Git worktree에서 관리된 쓰기, 동의한 검증 명령 | 기존 폴더를 agent가 직접 자유 수정, 임의 shell 자동 허용 |
| U3 · 검토와 반영 | 버전 고정 diff 의견, Reins/후속 Run, stale 판정, 원본 반영·역변경, 장애·보안·성능 검증 | 검증 없는 완전 자동 병합·push·프로세스 crash resume |

U1은 작은 완성 단위지만, **상용급 코딩 작업 경험이 완성되었다고 주장할 단계는 아니다**. 코딩 일반 제공은 U2/U3의 안전·복구 gate가 필요하다. 단계 번호는 기존 프로젝트 release 번호를 대체하지 않는다.

이번 개선에서 미루는 항목: 같은 Session의 병렬 쓰기 Run, 임의 에이전트별 worktree 병렬화, Git index 편집·hunk stage, 자동 커밋/PR/push, 원격 협업 계정, 플러그인 마켓, 상주 터미널·IDE 전체 복제, 실행 중 그래프 구조 수정. Local/Jev 및 현재 effort 관찰 기능은 제거하지 않되 이번 개선의 의존 조건으로 삼지 않는다.

## 5. Project·Session 정책

### 5.1 Project

프로젝트 이름·설명·선택적 기본 팀·버전이 있는 공통 지침·자료를 저장한다. 폴더를 연결할 때 실제 경로·Git 상태·권한 범위를 사용자에게 확인시킨다. 프로젝트를 선택한다고 디렉터리 전체가 모델 입력으로 자동 전송되지 않는다.

민감 파일·프로젝트 지침·학습된 세션 결론을 자동으로 모든 세션에 공유하지 않는다. 세션의 결정을 공통 지침으로 올리는 것은 별도의 사용자 작업이다.

### 5.2 Session

제목, 목적, 생성/최근 활동 시각, 기본 팀 참조, 현재 workspace epoch, 고정·보관 여부, 요청·답변·피드백·결정·Run 링크를 저장한다. `Session.status` 하나로 모든 상태를 축약하지 않는다. 보관 여부와 실행 중·검토 필요 같은 badge는 분리한다.

종료한 Run에 새 입력을 쓰지 않는다. 후속 요청은 새 Run이다. 세션 분기는 미래 확장 포인트로 기록하되 자동 분기 UI는 U1 필수가 아니다. Run 복구와 세션 재열람도 다르다.

### 5.3 입력 행동

| 상황 | 기본 동작 | 명확히 선택 가능한 대안 |
|---|---|---|
| 활성 Run 없음 | 같은 세션에서 후속 Run | 읽기 전용 결과 질문 |
| 활성 Run 있음 | 지정된 대상에 Steer, 대상 미지정이면 전송 전에 선택 | 다음 작업으로 대기 |
| 과거 Run 열람 | 과거 기록을 바꾸지 않고 새 후속 Run | 해당 결과에 대한 읽기 전용 질문 |
| 작업 폴더·정책 변경 | 다음 Run에서 적용 | 현재 Run은 기존 snapshot 유지 |

팀 전체 Steer를 임의 broadcast하지 않는다. 명시한 lead 노드 또는 사용자가 고른 Execution으로 전달한다. 인스턴스가 끝났다면 `undelivered/target_terminal`을 표시한다. 이미 승인한 `fallback=next_run` 정책이 없는 한 새 Run으로 조용히 전환하지 않는다.

결과 질문도 모델 호출이면 비용·이력을 갖는 `Run.kind=explain`으로 기록한다. 이 Run에는 파일 쓰기·shell·원본 반영 권한을 주지 않는다. 활성 Run 제한 때문에 기다려야 한다면 그 상태를 알려준다.

### 5.4 컨텍스트

다음 Run의 ContextSnapshot에는 요청, 채택된 프로젝트 지침 버전, 선택한 세션 결정, unresolved feedback, 참조 artifact/file version, 관련 검증, 모델 설정을 명시한다. 이전 전체 채팅을 무조건 모든 agent에 넣지 않는다.

요약은 편의용 파생 데이터다. 확정 원본과 구분하고 출처를 보존한다. 오래된 파일 내용은 최신처럼 전달하지 않는다. 기준이 바뀌면 사용자에게 갱신 또는 원본 유지 선택을 제공한다.

### 5.5 대기열

요청의 내용·팀 revision·자료 선택은 접수 시 고정한다. 실제 시작 시 workspace의 현재 상태·권한·예산을 재검사하고 시작 기준을 새로 잡는다. 그 결과가 접수 당시의 가정과 충돌하면 확인을 요구한다. 서버 재시작 후 대기 작업은 `needs_confirmation`이고 유료 호출을 자동 시작하지 않는다.

## 6. 결과를 단일 문자열에서 결과 집합으로 바꾸기

```text
ResultRevision
  summary
  deliverables[]       # 사용자가 받을 산출물
  changeSetRevisionIds[]
  verificationIds[]
  unresolvedItems[]
  sourceRunId + completeness
```

대표 요약은 선택적이다. 빈 문자열 하나를 성공 결과로 간주하지 않는다. 결과 페이지에는 최종 제출 산출물과 중간 산출물을 구분해서 모두 탐색할 수 있게 한다.

Output 노드는 여전히 최종 제출·종료 의도를 선언한다. 그러나 변경사항 수집은 Output 노드와 무관하게 실행 중에도 이뤄진다. 실패·취소 시에는 현재까지의 결과를 `partial`로 보존한다.

UI의 독립 상태: `실행 종료`, `검증`, `검토`, `원본 반영`. Git 커밋·push는 별도다. 검증을 안 했으면 `검증 안 함`, 파일 쓰기 기능이 없으면 `파일 작업 없음`이며, 둘 다 `통과/변경 없음`과 다르다.

HTML·Markdown 미리보기는 파일 diff와 공존한다. 코드 수정이면 변경 탭을, 문서 작성이면 산출물을 우선하되 사용자가 선택한 탭을 유지한다. 결과가 늦게 도착했다고 강제로 화면을 바꾸지 않는다.

## 7. 변경·비교·출처 계약

### 7.1 비교 종류

| 범위 | 기준 | 중요한 제약 |
|---|---|---|
| 이번 Run | Run 시작 snapshot → 선택한 결과 snapshot | 실패·취소 Run도 비교 가능 |
| Session 전체 | 현재 WorkspaceEpoch 시작 → 선택한 결과 snapshot | 작업 공간이 바뀌면 구간별로 표시 |
| 마지막 검토 이후 | 사용자가 고정한 검토 snapshot → 새 snapshot | 읽음 표시와 formal approval 구분 |
| Git 상태 | unstaged / staged / 기준 commit / 기준 branch | 시간 구간·agent 기여와 다른 의미 |

Run A에서 X→Y, Run B에서 Y→X면 세션의 순변경은 0이다. 변경 이력은 두 번 남는다. 세션 diff를 Run patch 문자열 결합으로 만들지 않는다.

서로 다른 작업 복사본을 한 세션에서 사용했다면 자동으로 연속된 기준이라고 가정하지 않는다. `WorkspaceEpoch`를 분리하고, 명시적으로 연결한 계보만 누적 비교한다.

### 7.2 변경 출처

`managed_agent`, `managed_user`, `external_observed`, `mixed`, `unknown`을 구분한다. 관리된 파일 작업은 run/execution/task/tool operation과 연결한다. Git diff·watcher만으로 agent 작성자까지 추정하지 않는다.

초기 세션 snapshot에 들어 있던 사용자 수정은 시간 구간 diff에서 기존 상태다. 생성 이전 이력을 Corral 작성으로 표시하지 않는다. 기존 HEAD와 달랐던 줄을 에이전트가 다시 수정하면 실제 변경 전후를 기록한다.

### 7.3 포함 범위와 파일 종류

경로·종류·bytes/hash·파일 모드·전후 버전을 저장한다. 지원되는 UTF-8 일반 텍스트는 diff, 새 파일은 전체 추가, 삭제는 이전 내용, 명시적으로 수행한 rename은 양쪽 경로를 보인다. 외부 rename 추정은 추정 표시를 붙인다.

바이너리·너무 큰 파일·인코딩 미지원·submodule·symlink는 각각 메타정보와 지원 범위를 표시한다. 생략한 파일을 없는 것으로 세지 않는다. 생성 파일과 lockfile은 기본 접되 실제 변경과 집계에서 지우지 않는다.

첫 코딩 베타의 쓰기는 UTF-8 일반 파일에 한정한다. 생성/수정/삭제/명시적 이동은 가능하되 symlink·submodule·special file을 통한 쓰기는 거부한다. CRLF, 마지막 개행, 실행 비트, 경로 대소문자 충돌을 별도 테스트한다.

## 8. 실제 작업 공간과 파일 쓰기

첫 기본값은 **기존 폴더 관측 + 격리 작업 복사본 쓰기**다. 현재 사용자의 폴더를 agent가 직접 편집하는 모드는 후속이다. 이는 파일 diff를 우선 제공하면서 손상 위험을 좁히기 위한 설계 선택이다.

새 worktree를 만들 때 기준 커밋과 기존 dirty 상태를 보여준다. 초기 버전은 commit 기준 생성만 허용한다. 사용자 미커밋 변경을 포함하려면 별도 snapshot/overlay 기능의 지원 여부를 명시해야 하며, 미지원일 때 조용히 버리거나 자동 stash/commit하지 않는다. 새 복사본에 기존 dirty 변경이 포함되지 않는다는 확인을 받는다.

같은 worktree를 여러 세션이 쓰도록 연결하지 않는다. agent들의 분석은 병렬이어도 Corral 파일 변경과 검증 프로세스는 해당 workspace의 write lease를 통해 제어한다. 초기에는 기존 전역 단일 활성 Run 제한도 유지한다. worktree의 Git lock은 파일 동시 쓰기를 막는 mutex가 아니다. [S01]

검증 명령은 테스트·빌드 preset으로 제한하고, 명령 argv·cwd·환경 노출·시간 상한을 확인받는다. preset이라고 안전한 코드는 아니다. npm script와 test runner는 임의 코드를 실행할 수 있다. OS 샌드박스가 없는 상태는 `신뢰한 프로젝트의 호스트 실행`으로 명시하고 이를 권한 격리로 광고하지 않는다.

## 9. 검토 → Reins → 반영

피드백은 한 줄마다 즉시 모델에 보내지 않는다. 여러 의견을 묶은 FeedbackBatch를 확인 후 제출한다. 특정 changeset revision과 before/after blob을 참조한다. 새 파일에서 같은 줄 번호를 발견했다고 자동 재부착하지 않는다.

현재 담당자가 활성 상태면 지정한 안전 경계에 전달한다. 종료됐다면 사용자가 확인한 새 수정 Run으로 수행한다. 피드백 처리 상태는 `draft / submitted / dispatched / addressed / verified / obsolete`를 분리한다. 모델이 addressed라 말한 것만으로 verified 처리하지 않는다.

검토는 특정 변경집합·완료 기준 버전에 대한 판단이다. 검증은 command/environment/workspace snapshot에 대한 실행 결과다. 파일이나 기준이 바뀌면 기존 승인은 삭제하지 않되 현재 버전에 적용 가능한지 재평가한다.

원본 반영은 별도 사용자 명령이다. 전체 변경집합을 기본 단위로 하며 초기에는 hunk 선택 적용을 넣지 않는다. `승인`이 곧 파일 반영·커밋·push가 아니다. 반영 계획에는 대상 폴더·대상 기대 상태·승인 revision·파일별 전후 상태가 있어야 한다.

여러 파일 반영은 DB 하나의 원자 작업이 아니다. 중간 실패가 있으면 적용된 파일과 남은 파일을 정확히 표시하고 reconciliation 상태로 남긴다. 역변경은 실제 적용 기록을 기준으로 새 계획을 만든다. 사용자가 이후 수정한 파일은 자동으로 덮어쓰지 않는다.

## 10. 비기능·운영 계약

서버 재시작 시 Session과 기록은 복원하되 미완료 Run을 조용히 재개하지 않는다. 파일 작업이 불명확하면 먼저 상태를 확인한다. 세션 화면을 닫는 것은 Runtime 종료가 아니다.

앱의 자료·API key·DB는 모델이 자유롭게 읽는 경로와 분리한다. Markdown raw HTML과 외부 이미지는 기본 차단한다. HTML 미리보기는 권한 없는 별도 origin/샌드박스에서 실행하며 첫 단계는 scripts/network 불허다. 다운로드·외부 열기는 사용자 동작으로만 한다.

보관은 데이터 삭제가 아니다. 작업 복사본 제거, 세션 기록 영구 삭제, 코드 되돌리기를 독립 명령으로 둔다. 삭제는 원본이 아니라 Corral 소유 데이터만 대상으로 하며 감사·참조 관계·백업의 별도 존재를 확인시킨다. 저장 불변성은 '사용자도 삭제할 수 없음'을 의미하지 않는다.

성능 수치는 02-UX-Spec과 05-Test-Plan의 **출시 목표**이며 측정된 결과가 아니다. 외부 모델 응답 지연과 로컬 조작 latency를 분리 측정한다.

## 11. 명세 변경 관리

이번 제안은 기존 명세를 폐기하지 않는다. `CR-WB-001`을 전체 개선의 **제안용 상위 변경 요청 ID**로 사용한다. 작업 단위·결과/파일·검토/Reins·저장/이관은 기능 명세와 WB-ADR로 구분한다. 기존 CR 번호와 충돌 여부는 적용 직전 확인한다.

실제 구현 전에는 이 제안의 선택사항을 승인하고, 관련 feature spec·계약·테스트·ADR를 함께 갱신한다. 코드 없는 문서 PR과 정상/실패 mock UI를 먼저 검토한 뒤 실제 파일 쓰기를 열어야 한다.

## 12. 요구사항 목록

| ID | 요구 | 수용 기준 | 단계 |
|---|---|---|---|
| WB-PRJ-001 | 프로젝트와 실행 디렉터리 분리 | 폴더 없는 프로젝트를 생성할 수 있고, 폴더 연결은 별도 WorkspaceBinding이다. | U1 |
| WB-PRJ-002 | 데이터 루트와 권한 경계 | 앱 데이터 저장 위치를 작업 대상 폴더로 오인하지 않는다. 등록된 경로도 명시적 권한을 받아야 접근한다. | U1 |
| WB-SES-001 | 지속되는 작업 세션 | 이름·목적·대화·선택 팀·Run 이력·초안을 보존하고 검색·고정·보관할 수 있다. | U1 |
| WB-SES-002 | 후속 실행 | 완료 후 후속 요청은 같은 Session의 새 Run을 생성하며 과거 Run을 다시 열어 쓰지 않는다. | U1 |
| WB-SES-003 | 입력 의도와 대상 | Steer·다음 작업·결과 질문을 구분하고 실행 종료와 경합할 때 조용히 다른 대상으로 전환하지 않는다. | U1 |
| WB-SES-004 | 맥락 스냅샷 | 이전 결정·미해결 피드백·자료·지침을 선택해 전달하고 실제 입력 버전을 기록한다. | U1 |
| WB-SES-005 | 대기열과 실행 승인 | 대기 요청의 팀·입력은 고정하고 실제 시작 직전 작업 공간과 권한을 재검사한다. 재시작 후 자동 재실행하지 않는다. | U1 |
| WB-RES-001 | 결과 집합 | 대표 요약과 여러 산출물·변경집합·검증·미해결 항목을 함께 표시한다. 첫 산출물만 결과로 간주하지 않는다. | U1 |
| WB-RES-002 | 실패·취소 후 부분 결과 | Output 도달과 무관하게 이미 생성된 산출물과 관측된 변경을 보여준다. | U1 |
| WB-RES-003 | 완료 의미 분리 | 실행·검증·사용자 검토·반영·Git 커밋 상태를 서로 독립적으로 표시한다. | U1 |
| WB-DIF-001 | 재현 가능한 비교 | 불변 before/after 버전과 비교 범위를 고정한다. 과거 diff를 현재 파일에서 다시 생성하지 않는다. | U2 |
| WB-DIF-002 | 비교 범위 | Run·Session 구간·마지막 검토·Git 기준을 구분한다. Run별 diff를 합쳐 세션 diff라고 하지 않는다. | U2 |
| WB-DIF-003 | 변경 출처 | 관리된 쓰기·사용자 입력·외부 관측·혼합·불명 출처를 구분한다. 시간적 동시성으로 작성자를 추정하지 않는다. | U2 |
| WB-DIF-004 | 파일 유형과 누락 | 추가·수정·삭제·이동·바이너리·대형·생성 파일을 구분하고 생략을 숨기지 않는다. | U2 |
| WB-DIF-005 | 시작 기준 | 기존 미커밋 변경·index·포함 범위를 기록한다. 불안정한 스캔을 일관된 스냅샷으로 확정하지 않는다. | U2 |
| WB-WSP-001 | 읽기 전용 관측 | 등록한 기존 폴더의 관측은 에이전트 수정 권한을 부여하지 않는다. | U2 |
| WB-WSP-002 | 격리된 코딩 작업 | 첫 파일 쓰기는 명시적으로 만든 Git worktree에서만 허용한다. worktree를 보안 샌드박스로 표시하지 않는다. | U2 |
| WB-WSP-003 | 파일 변경 직렬화 | 같은 작업 공간에 대한 Corral 쓰기는 하나의 실행 경로를 거치고 기대 버전을 확인한다. | U2 |
| WB-WSP-004 | 외부 수정 충돌 | 기대 버전과 다른 파일을 조용히 덮어쓰지 않는다. 외부 프로세스와의 완전한 OS 수준 CAS를 약속하지 않는다. | U2 |
| WB-WSP-005 | 파일 작업 장애 조정 | 수정 의도와 전후 버전을 보존하고 기록 불일치를 확인 전까지 차단한다. 불명 작업은 자동 재실행하지 않는다. | U2 |
| WB-WSP-006 | 검증 명령 | 검증은 명령·환경·대상 스냅샷·실제 종료 결과로 기록한다. 프로젝트 스크립트는 신뢰 승인이 필요한 코드다. | U2 |
| WB-REV-001 | 버전 고정 피드백 | 경로와 줄 번호뿐 아니라 changeset revision·before/after·side·범위를 저장한다. | U3 |
| WB-REV-002 | 피드백에서 Reins로 | 검토 의견을 묶어 명시한 실행에 전달하거나 같은 세션의 새 수정 Run으로 시작한다. | U3 |
| WB-REV-003 | 검토 유효성 | 변경·기준·환경이 달라지면 검증과 승인의 적용 가능성을 재판정한다. 읽음과 승인은 다르다. | U3 |
| WB-REV-004 | 원본 반영 | 승인한 changeset과 대상 현재 상태를 확인한 반영 계획을 사용한다. 여러 파일 적용의 중간 실패를 기록한다. | U3 |
| WB-REV-005 | 되돌리기 | 취소와 복원은 별도다. 실제 반영 결과를 기준으로 역변경을 계획하고 이후 사용자 수정을 보호한다. | U3 |
| WB-UX-001 | 목적별 화면 | 작업·팀 설계·실행 상세·검토의 주요 화면을 제공한다. 검토에서는 diff가 중앙을 사용한다. | U1 |
| WB-UX-002 | D&D 유지 | 지원 노드 배치·연결·저장·실행을 유지하며 그래프를 읽기 전용 설정 메뉴로 축소하지 않는다. | U1 |
| WB-UX-003 | 팀과 요청 분리 | 재사용 팀 정의와 이번 Run 입력을 구분한다. 실행 중 구조는 고정하고 편집은 다음 Run 초안이다. | U1 |
| WB-UX-004 | 전환·재접속 | 세션별 초안·선택·스크롤을 보존하고 화면 해제가 실제 실행 취소를 일으키지 않는다. | U1 |
| WB-UX-005 | 접근성 | 키보드로 탐색·패널·검토·Reins를 사용할 수 있고 한국어 IME 입력 중 전송되지 않는다. | U3 |
| WB-UX-006 | 성능 | 목록 페이지네이션·가상화·diff 지연 로딩·버퍼 상한을 적용하고 정해진 장비·fixture로 측정한다. | U3 |
| WB-SEC-001 | 도구와 경로 권한 | 역할 허용 도구와 파일 경로·명령 권한을 실제 실행 직전에 함께 검사한다. | U2 |
| WB-SEC-002 | 안전한 결과 표시 | 파일·Markdown·HTML은 신뢰하지 않는다. 미리보기는 격리하며 임의 스크립트를 기본 실행하지 않는다. | U2 |
| WB-SEC-003 | 보관·삭제·공유 | 보관·작업 공간 제거·기록 삭제·코드 복원을 구분하고 export의 비밀정보 포함 여부를 확인한다. | U3 |
| WB-MIG-001 | 과거 기록 유지 | 기존 Run·artifact ID·이벤트를 유지하고 추가 매핑으로 세션을 부여한다. 역사적 파일 상태를 만들어내지 않는다. | U1 |
| WB-MIG-002 | 저장 계약 진화 | 버전·해시·명령 멱등성·스키마 호환을 명시한다. 기존 DB를 조용히 다른 폴더로 이동하지 않는다. | U1 |
| WB-OBS-001 | 개입·변경 인과 | 지시가 실제 전달된 요청과 파일 작업을 연결한다. 생성 시각만으로 인과를 붙이지 않는다. | U3 |
| WB-OBS-002 | 확인 필요 목록 | 승인·질문·충돌·재검토를 프로젝트 전역에서 보여주되 실제 처리할 항목만 모은다. | U3 |
| WB-DEV-001 | SDD·TDD 증거 | 각 요구사항을 실패 테스트·태스크·PR·검증 증거로 연결한다. mock과 live 결과를 구분한다. | U0 |


---

# Corral Studio 화면·상호작용 개선안

상태: 설계 제안. 화면을 실행해 검증한 결과는 아니다. 모든 숫자는 초기 설계값 또는 평가 목표다.

## 1. 정보 구조

```text
Corral Studio
  프로젝트 / 최근 세션
    프로젝트
      세션
        작업
        팀 설계
        실행 상세
        검토
  확인 필요
  팀 라이브러리
  모델·도구·저장 설정
```

전역 메뉴에 Run·Task·Execution·Artifact를 모두 같은 깊이로 늘어놓지 않는다. 사용자는 목적과 프로젝트로 탐색하고, 실행 상세가 필요할 때 기술 단위를 펼친다.

새 프로젝트는 '폴더 연결' 또는 '자료로 시작'을 선택한다. 새 세션은 제목이 없어도 목적 한 줄로 만들 수 있다. 자동 제목은 사용자 편집 가능하며 비용이 드는 모델 호출을 기본 사용하지 않는다.

## 2. 기본 작업 화면

```text
┌─────────────────────────────────────────────────────────────────────┐
│ 프로젝트 / 세션     팀: 구현·검토 v3     복사본: session-42    상태    │
├───────────────┬───────────────────────────────┬─────────────────────┤
│ 검색          │ 작업 | 팀 설계 | 실행 상세     │ 변경 | 산출물 | 검증 │
│ 확인 필요 2   │                               │                     │
│               │ 요청                          │ 이번 실행 ▾         │
│ Corral        │ 계획·핵심 진행                 │ 파일 18개           │
│  UI 개선      │ 활성 팀: 구현 2 / 검토 1      │ src/...             │
│  오류 수정    │ 승인 또는 질문 카드            │ tests/...           │
│               │                               │                     │
│ 다른 프로젝트 │ 결과 요약                      │ 선택 결과 미리보기   │
│               │ 미해결 항목                    │ [검토 화면으로 확대] │
│ 팀 라이브러리 │ 대상·적용 시점                  │                     │
│ 설정          │ 지시 입력               전송   │                     │
└───────────────┴───────────────────────────────┴─────────────────────┘
```

도면의 파일 수·팀 버전·상태는 예시다. 실제 화면은 서버에서 확인된 사실을 표시한다.

좌측은 약 240px, 우측은 약 360px를 출발값으로 조정 가능하게 한다. 최소 폭 이하에서는 보조 패널을 탭으로 바꾸고, 사용자의 선택에 따라 레이아웃을 기억한다. 숫자를 CSS 고정 폭 제약으로 전역 강제하지 않는다.

헤더에는 언제나 프로젝트, 세션, 작업 경로/복사본, 팀 revision, 실행 상태, 권한 모드가 보인다. 전체 절대 경로는 기본 축약하되 클릭으로 확인한다. 실행 버튼 옆에 실제/모의 모드를 명확히 표시한다.

## 3. 네 화면의 역할

### 작업

사용자 요청·주요 진행·질문·승인·결과가 중심이다. 모든 raw model/tool message를 한 채팅에 나열하지 않는다. Run별 카드를 펼쳐 원문에 접근한다. 사용자가 위쪽을 읽는 동안 새 이벤트가 와도 자동 맨 아래 스크롤을 강제하지 않는다.

실행 완료 카드에는 '수행함 / 검증함 / 못 끝냄 / 다음 행동'을 분리한다. 모델 요약은 `에이전트 요약`, 실제 테스트·수정 사실은 검증 가능한 카드로 구분한다.

### 팀 설계

기존 Canvas를 주요 화면으로 유지한다. 역할 D&D·연결·허용 위임 관계·Loop·설정·검증을 제공한다. 실행 중에는 `실행에 적용된 v3`와 `편집 중인 다음 실행 초안`을 구분한다. 현재 Run이 바뀐 것처럼 보여서는 안 된다.

템플릿 사용자는 곧바로 작업을 시작할 수 있고, 세밀한 사용자는 팀을 직접 조립한다. D&D를 매번 수행하도록 강제하지 않는 것과 D&D를 숨기는 것은 다르다.

### 실행 상세

현재 Run의 설계 그래프·실제 실행 트리·협업 로그를 연결한다. 작업/파일/피드백에서 들어온 선택을 유지한다. 실행 tree에서 선택한 node에는 역할명, 회차, 상태, 대기 대상, 변경 파일 수, 관련 지시가 보인다. source attribution이 불확실하면 파일을 특정 node의 결과로 단정하지 않는다.

### 검토

중앙을 diff에 할당하고, 좌측 보조 영역은 파일 트리, 우측은 의견·Reins·검증을 둔다. 프로젝트 사이드바는 접을 수 있다. 코드를 좁은 오른쪽 패널에 가두지 않는다. 작업 화면으로 돌아갈 때 선택 파일과 scroll 위치를 보존한다.

## 4. 검토 화면의 세부 계약

```text
비교: 마지막 검토 이후 ▾   기준: snapshot A → snapshot B   [새 변경 3]

파일 검색 / 미검토만 / 종류 / 생성파일 표시
  M src/ui/session.tsx       +84 -12   미검토
  A src/ui/project-tree.tsx  +110       검토함
  D src/old-output.tsx       -66
  R src/a.ts → src/b.ts      (관리된 이동)
  B assets/diagram.png      이미지 변경

선택 파일: src/ui/session.tsx     출처: Corral + 외부 수정 혼합
[통합] [나란히] [원본] [검토함] [의견 추가]
  ... immutable before/after diff ...

의견 3개 작성 중                    [수정 요청 보내기]
```

- `검토함`은 읽음 상태다. 팀 승인·기준 충족과 다르다.
- 선택 영역은 side와 before/after 버전에 묶인다. 새 revision에서는 원문 의견을 보여주되 자동 해결 처리하지 않는다.
- 큰 diff는 단일 파일씩 로드한다. 전체 파일을 Monaco model로 동시에 만들지 않는다.
- 생성 파일/lockfile은 접힘을 기본값으로 하되 삭제나 보안 관련 변경은 계속 눈에 띄게 한다. 숨긴 항목 수를 표시한다.
- 바이너리·누락·권한 차단은 '변경 없음'으로 표현하지 않는다.
- 워드/문서 작업은 결과 미리보기와 이전 버전 비교를 유지한다.
- diff 계산이 시간 상한을 넘으면 `계산 중단`과 파일 원문 보기/다운로드를 제공한다. 무한 spinner 금지.

## 5. 새 세션 시작 흐름

1. 프로젝트 선택 또는 새 프로젝트 생성.
2. 목적 입력. 기본 팀을 사용하거나 팀 라이브러리/Canvas에서 선택.
3. 파일 작업이면 대상 폴더, 실행 복사본, 시작 기준과 권한을 확인.
4. 기존 미커밋 변경이 있으면 무엇이 새 복사본에 포함되는지 표시.
5. 실행 전 요약: 목적·팀·모델 연결·도구 권한·한도·파일 작업 여부.
6. 실행. 대기 중이면 이유와 예상 가능한 다음 조건을 표시. 임의 완료율·추정 완료 시간 금지.

자료 분석 프로젝트는 3·4단계를 생략하고 선택 자료·외부 전송 경계를 표시한다. 기존 모델 로그인/설정·mock demo를 재구현하지 않는다.

## 6. 후속 작업과 입력창

완료한 Run 아래의 입력창은 '이 세션에서 계속'이다. 원래 목적이 섞이지 않도록 후속 목표가 새 Run의 brief가 된다. 팀 설정의 input은 기본값으로만 남는다.

실행 중 입력창에는 target chip과 적용 경계가 항상 보인다. 예: `작성 담당 #7 · 다음 모델 요청`. 입력 중 target을 바꿀 때 초안을 버리지 않는다. target이 종료되면 전송 버튼 상태를 갱신하고 사용자가 결정하도록 한다.

다음 작업 대기는 비용이 발생하는 실행 예약이다. 자동 시작 여부는 한 번 명시적으로 설정하고 queue 항목마다 취소/수정 가능하다. 수정하면 새 version으로 기록한다. 실행 중 팀 정의가 변경되어도 이미 대기한 요청의 의미를 몰래 바꾸지 않는다.

모든 전송은 command ID를 갖는다. 네트워크 응답을 잃으면 같은 ID로 receipt를 조회/재시도한다. 단순 재전송 버튼 때문에 Run을 두 개 생성하지 않는다.

## 7. Reins의 표시 단계

| 단계 | UI 예시 | 확인한 사실 |
|---|---|---|
| sending | 전송 중 | 로컬 요청 중 |
| accepted/queued | 접수됨·전달 대기 | 서버가 명령을 기록 |
| attached | 다음 요청 입력 준비에 포함 | 아직 외부 호출 시작은 아님 |
| dispatched | 요청 #123에 전달됨 | 실제 모델 요청 경계에 적용 |
| addressed | 에이전트가 수정 결과를 제출 | 지시를 충족했다고 확정하지 않음 |
| verified | 해당 기준으로 검토 확인 | 누가 무엇을 검토했는지 연결 |
| undelivered/rejected | 전달되지 않음·대상 종료 | 조용한 fallback 없음 |

서버의 현재 directive 이벤트 계약을 새 UI에서도 보존한다. 이름만 다른 별도 steering 큐를 클라이언트에 만들지 않는다. [R04]

팀 전체 목표 수정은 active worker별 수신 시점 차이가 있다. 전체 pause와 기준 변경이 필요한 명령은 별도 제어로 유지한다. diff 피드백이 security policy를 자동 수정하지 않는다.

## 8. 빈 상태·에러·복구

| 상태 | 사용자에게 보여줄 것 | 가능한 행동 |
|---|---|---|
| 프로젝트 없음 | 폴더 없이도 시작 가능 | 새 프로젝트 / 기존 기록 가져오기 |
| 세션 없음 | 기본 팀과 목적 입력 | 새 세션 |
| 파일 미연결 | 이 세션은 문서·자료 작업 | 작업 폴더 연결 |
| workspace 없음/이동됨 | 마지막 경로와 검증 실패 | 재연결, 기록 읽기 |
| 변경 내용 수집 전 | 기준 준비 중 | 취소 / 상세 |
| 변경 0개 | 비교 범위 안에서 변경 없음 | 범위 변경 |
| 수집 생략 | N개 크기·권한 제한 | 생략 목록 |
| run 실패/취소 | 남아 있는 변경·산출물 | 검토 / 후속 Run / 별도 복원 |
| 적용 충돌 | 현재 파일이 승인 당시와 다름 | 비교 / 새 반영 계획 |
| 백엔드 연결 끊김 | 실행 상태를 확인할 수 없음 | 재접속; 성공/취소로 단정 금지 |
| 기록 손상/지원 불가 | 읽을 수 없는 항목과 이유 | 안전한 export/지원 정보 |

확인 필요 Inbox에는 사용자 행동이 필요한 대상만 노출한다. 사용자 승인·질문·충돌·불명 파일 작업·재검토가 포함된다. UI를 한 번 열었다고 처리 완료되지 않는다. 정해진 대상 revision에 대한 명령 성공으로 닫는다.

## 9. 상태 저장과 전환

서버 사실: Project/Session 메타정보, Run projection, 결과·피드백·승인.
클라이언트 편집 상태: Canvas 초안, 입력 초안, 아직 제출하지 않은 의견.
뷰 상태: 선택 탭·파일·실행·scroll·panel layout.
스트림 상태: 임시 model delta, 진행 text.

네 종류를 한 Zustand 객체의 큰 배열로 합치지 않는다. 파일 diff 본문은 변경되지 않는 blob key로 cache한다. 각 sessionId/changesetRevision/file key로 selection과 draft를 구분한다.

선택 Session만 상세 stream을 구독하고 다른 세션은 얇은 summary feed로 상태를 받는다. route unmount는 UI observer만 해제한다. Run cancel은 명시적 사용자 명령만이다.

## 10. 접근성과 포트폴리오 품질

D&D와 동일한 의미를 키보드 노드 추가·연결 명령으로 제공한다. 패널 resizer·탭·트리·diff·Reins를 키보드로 조작한다. error focus를 관련 입력으로 이동한다. 화면 전체가 계속 aria-live로 낭독되지 않도록 중요한 상태만 요약한다.

한국어 IME 조합 중 Enter는 전송하지 않는다. Cmd/Ctrl+Enter 같은 전송 단축키를 설명하고, input focus를 canvas shortcut이 가로채지 않게 한다. 레이아웃 전환 중 입력한 지시를 잃지 않는다.

Desktop을 우선 지원한다. 좁은 화면에는 통합 텍스트 diff와 탭식 패널을 제공한다. Monaco가 공식적으로 mobile을 지원한다고 가정하지 않는다. [S03]

모의 데모는 Project 2개·Session 6개·다중 파일·취소·피드백 흐름을 제공한다. 비밀정보 없는 fixture를 사용하고 `모의 실행`을 지속 표시한다. 미리 녹화한 영상만으로 인터랙티브 기능이 된다고 표시하지 않는다.

## 11. 측정 목표

아래는 초기 목표이며 성능·사용성 검증 전 값이다. 공식 benchmark처럼 발표하지 않는다.

- fixture: 프로젝트 30, 세션 500, 결과 파일 500, Run 이벤트 20,000, 일반 텍스트 파일 200KB. 대형 파일 fallback은 별도.
- 일반화된 기기: 실제 테스트 OS·CPU·RAM·browser·build hash 기록. loopback, warm/cold 구분.
- warm 세션 전환 후 주요 내용 표시 p95 300ms 이하를 목표. 원격 모델 응답시간 제외.
- 일반 파일 선택 후 diff 표시 p95 500ms 이하를 목표. 초과 시 측정 후 budget 수정 또는 기능 제한.
- 변경 100개 이상에서도 파일 tree는 필요한 행만 렌더링. model text delta 때문에 canvas 전체가 재렌더되지 않아야 함.
- panel/drag 중 long task 횟수와 입력 지연을 측정. 목표 미달을 숨기지 않는다.
- 세션 50회 전환 후 Monaco model 수가 열린 비교 2개와 허용 LRU 범위로 복귀하는지 검사.
- 사용자 평가: 최소 5명의 과제 기반 탐색 테스트를 초기 방법으로 제안. 표본으로 시장 효과를 일반화하지 않는다. '어제 작업 찾기', '변경/미반영 구분', 'diff 의견 전달 대상 확인' 성공 여부를 관찰한다.


---

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


---

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


---

# 수용·회귀·장애 테스트 계획

**아래는 계획된 테스트다. Corral 앱에서 실행하거나 통과한 결과가 아니다.** 문서의 연결 관계를 검사한 것과 제품 테스트를 구분한다.

## 1. 필수 fixture

- 기존 main DB schema와 completed/failed/cancelled/interrupted Run, startedFrom, 복수 output artifact.
- Git repo: clean, staged/unstaged 상이, untracked, rename, 삭제, CRLF, no-final-newline, binary, symlink, submodule, 충돌 index.
- 안전한 경로: spaces, Unicode, leading dash, newline, Windows drive/case/junction, POSIX symlink. 실제 지원 OS에서 검증.
- project/session: 폴더 없는 문서 프로젝트, 같은 제목의 다른 Session, archived session, missing workspace.
- fault: response lost, duplicate command, out-of-order/gap stream, storage fail, partial FS write, process crash, permission change, external edit.
- UI: 30 projects/500 sessions/20,000 events/500 files, slow diff, malformed artifact, HTML injection.

fixture에는 실제 사용자 코드·secret·개인 경로를 포함하지 않는다. clock/id/process/file IO를 주입하고 seed를 고정한다.

## 2. 검증 계층

Unit/property → SQLite/file integration → component/Storybook → browser E2E → opt-in live 순이다. 순수 contract test가 통과해도 Git·OS 동작은 실제 temp directory와 process에서 따로 검증한다. simulator의 cancel 지원을 실제 child process 종료 증거로 재사용하지 않는다.

Property test 후보: 세션 요청 멱등성, terminal 상태 불변, 같은 bytes의 서로 다른 origin 처리, net diff 상쇄, 승인 revision 변경 시 stale, cancelled fence 이후 쓰기 admission 거부, queue pending 결과와 session 선택 독립.

UI의 실행 전송·결과 표시에는 서버 committed fact만 쓰도록 테스트한다. token stream에 '완료'라는 텍스트가 있어도 status를 성공으로 바꾸면 실패다.

## 3. 핵심 End-to-End 시나리오

### E2E-A · 기존 작업 이어가기

프로젝트를 만들고 팀을 D&D로 구성한다. 문서 Run을 수행한다. 여러 산출물을 확인하고 세션 제목을 수정한다. 재시작 후 해당 Session을 검색해서 후속 요청을 한다. 새 Run 하나가 생성되고 과거 기록이 보존된다.

### E2E-B · 격리 코딩과 검토

dirty인 저장소를 등록한다. dirty 변경 제외와 기준 commit을 확인하고 worktree를 만든다. agent가 텍스트 파일 여러 개를 수정한다. 실제 diff와 승인한 test command 결과를 본다. 원본이 아직 미반영임을 확인한다.

### E2E-C · diff에서 조율

두 파일에 의견을 작성해 batch로 제출한다. active target에 실제 directive가 전달되거나, 종료한 target이면 명시된 새 수정 Run을 시작한다. 수정된 changeset에서 이전 의견을 추적하고 다시 검증한다. 승인한 revision에 대해 원본 반영 계획을 확인해 실행한다.

### E2E-D · 실패·취소·충돌

위 흐름을 별도 실행으로 변형한다. 실행 중 cancel, 파일 수정 후 test 실패, 검토 후 외부 원본 edit, 반영 중 실패를 각각 발생시킨다. 남은 변경·불명 효과·충돌·다음 행동이 정확히 보이고 사용자 작업이 무단 삭제되지 않아야 한다.

정상 완료와 취소를 같은 Run에서 동시에 만족하도록 요구하지 않는다. 동일 definition을 쓰더라도 각 경로는 별도 테스트다.

## 4. 테스트 목록

| ID | 요구 | 시나리오 | Given | When | Then | 계층 |
|---|---|---|---|---|---|---|
| WBTST-001 | WB-PRJ-001 | 폴더 없는 프로젝트 | 등록 파일 없음 | 프로젝트와 세션을 생성 | 목적·팀을 저장하고 파일 작업 없음으로 시작 | integration |
| WBTST-002 | WB-PRJ-002 | data root와 대상 경로 | 기존 .corral DB가 있는 설치 | 새 프로젝트를 등록 | 기존 data root에 쓰기 권한이 자동 부여되지 않음 | integration |
| WBTST-003 | WB-SES-001 | 재시작 후 세션 찾기 | 서로 다른 프로젝트에 같은 제목 세션 존재 | 이름 검색·보관·서버 재시작 | ID와 이력·보관 상태가 보존되고 혼동 없음 | e2e |
| WBTST-004 | WB-SES-002 | 후속 Run | Run1이 종료하고 artifact가 존재 | 후속 요청을 전송 | 같은 Session에 Run2 하나 생성, Run1 원본 불변 | integration |
| WBTST-005 | WB-SES-003 | Steer 대상 종료 | 지시 입력 중 target Execution이 종료 | 지시 전송 | undelivered/target_terminal; 다른 worker나 새 Run으로 자동 이동 없음 | race |
| WBTST-006 | WB-SES-004 | 실제 맥락 고정 | project 지침 v1과 결정·자료가 선택됨 | Run 시작 후 project 지침을 v2로 수정 | 기존 요청 context는 v1, 새 Run에서만 재해석 | unit |
| WBTST-007 | WB-SES-005 | queue 재시작 | 유료 호출 대기 요청이 저장됨 | 백엔드 재시작 | 재확인 전 새 모델 호출 없음; 고정 startCommandId 유지 | fault |
| WBTST-008 | WB-RES-001 | 복수 output | output artifact가 3개 존재 | 결과 화면 열기 | 3개 모두 탐색 가능하며 첫 항목만 로드하는 경로 제거 | component |
| WBTST-009 | WB-RES-002 | 실패 후 결과 | 두 파일 변경과 artifact 후 test 실패 | terminal failed 기록 | partial 결과와 변경 유지; outputPending만 보이지 않음 | e2e |
| WBTST-010 | WB-RES-003 | 완료 의미 분리 | 에이전트 실행은 끝났으나 test 미실행 | 결과 화면 열기 | 실행 완료/검증 안 함/검토 대기/원본 미반영을 독립 표시 | component |
| WBTST-011 | WB-DIF-001 | 과거 diff 열람 | before A after B의 불변 revision 존재 | 현재 파일을 C로 바꾸고 과거 결과 열기 | A↔B 표시; C를 after로 사용하지 않음 | integration |
| WBTST-012 | WB-DIF-002 | 순변경 상쇄 | Run1 A→B, Run2 B→A | 세션 전체와 Run2 비교 전환 | 세션 net 0, Run2 B→A, 이력 둘 다 존재 | unit |
| WBTST-013 | WB-DIF-003 | 외부 변경 귀속 | agent 실행 중 외부 editor가 다른 파일 수정 | snapshot 생성 | 외부/불명으로 표시; 시간만으로 agent 작성자 부여 안 함 | integration |
| WBTST-014 | WB-DIF-004 | 특수 파일 결과 | 추가/삭제/rename/binary/큰 파일/CRLF 존재 | 변경 조회 | 유형·생략·EOL 의미 보존, unavailable과 empty 구분 | integration |
| WBTST-015 | WB-DIF-005 | 기존 dirty 기준 | HEAD와 index와 working file이 모두 다름 | Run baseline 수집 | 기존 상태를 기록하고 신규 변경과 섞지 않음 | integration |
| WBTST-016 | WB-WSP-001 | 읽기 전용 파일 연결 | 관측용 workspace 등록 | agent가 write 요청 | 권한 거부, filesystem 변경 없음 | security |
| WBTST-017 | WB-WSP-002 | 격리 복사본 | source가 dirty이며 committed base 존재 | worktree 생성 확인 | dirty 제외가 명시되고 원본 파일 불변, 별도 root 확인 | integration |
| WBTST-018 | WB-WSP-003 | 병렬 쓰기 요청 | 두 worker가 같은 before hash로 수정 제출 | 두 효과를 순서대로 처리 | 첫 적용 후 두 번째는 stale/conflict, last-write-wins 아님 | race |
| WBTST-019 | WB-WSP-004 | 외부 edit 경합 | 계획 after 저장 후 외부 edit 발생 | 효과 직전 검사 | 관측된 mismatch를 거절하고 외부 edit 보존 | race |
| WBTST-020 | WB-WSP-005 | FS 성공 기록 실패 | 파일 after 적용 후 DB outcome 저장 실패 | 프로세스 재시작 | uncertain/reconciliation; 확인 없이 재적용 없음 | fault |
| WBTST-021 | WB-WSP-006 | 검증 대상 변화 | snapshot A에 대해 test 시작 | test 중 입력 파일 변경 | 고정 A의 pass로 확정하지 않고 unstable/stale 표시 | integration |
| WBTST-022 | WB-REV-001 | 의견 anchor | diff revision1의 오른쪽 40줄에 의견 | revision2에서 줄이 이동 | 원래 before/after와 범위 유지; 자동 해결 금지 | unit |
| WBTST-023 | WB-REV-002 | 피드백 일괄 전달 | 미제출 의견 4개와 active worker 존재 | 수정 요청 보내기 | 한 batch로 명시 target에 전달, request/directive와 결과 연결 | e2e |
| WBTST-024 | WB-REV-003 | 승인 뒤 변경 | changeset v1/criteria c1 승인됨 | 파일 또는 기준 c2 변경 | 기존 승인 기록 유지, 현재 적용 가능 상태는 stale | unit |
| WBTST-025 | WB-REV-004 | 반영 대상 변동 | 승인 source와 target snapshot T1 존재 | 원본이 T2가 된 뒤 반영 요청 | 409 충돌, 대상 덮어쓰기 없음 | integration |
| WBTST-026 | WB-REV-005 | 복원 뒤 사용자 작업 보호 | 원본에 변경 반영 후 사용자 edit | 역변경 요청 | 변경 전후 검사 후 충돌 안내, 사용자 edit 무단 삭제 없음 | integration |
| WBTST-027 | WB-UX-001 | 검토 화면 확대 | 작업 화면에서 파일 선택 | 검토 화면으로 확대 후 복귀 | diff 주화면과 선택·scroll 보존 | e2e |
| WBTST-028 | WB-UX-002 | D&D 회귀 | 지원 노드를 Canvas에 배치 | 연결·저장·실행 | 수정된 실행 구조 반영, 새 UI가 단순 read-only graph가 아님 | e2e |
| WBTST-029 | WB-UX-003 | 팀 초안 분리 | Run이 팀 v3로 실행 중 | 다음 실행용 graph/기본 입력 편집 | 현재 Run 불변, draft 표시와 다음 Run 반영 | e2e |
| WBTST-030 | WB-UX-004 | 작업 전환 후 잘못된 지시 방지 | 세션 A에 미확정 명령과 입력 초안 존재 | B로 전환 후 A 응답 도착 | B 상태·target에 A 결과가 쓰이지 않고 A 초안 보존 | race |
| WBTST-031 | WB-UX-005 | IME와 키보드 | 한국어 조합 중 입력창 focus | Enter 및 panel/canvas 단축키 | 조합 중 전송 없음, 키보드로 조작 가능한 focus 흐름 | e2e |
| WBTST-032 | WB-UX-006 | 대규모 fixture | session 500/event 20000/file 500 fixture | 세션·파일 반복 전환 | 기기 기록과 목표 비교, model/cache 누수 검사 | performance |
| WBTST-033 | WB-SEC-001 | 경로 탈출 | 허용 root와 비허용 secret 경로 존재 | ../·absolute·symlink·junction·.git 쓰기 요청 | 거부되고 비허용 내용은 모델·로그에 없음 | security |
| WBTST-034 | WB-SEC-002 | 생성 HTML | script/remote image/postMessage 공격을 포함한 결과 | 미리보기 열기 | 앱 권한/쿠키/네트워크와 분리, script 기본 실행 안 됨 | security |
| WBTST-035 | WB-SEC-003 | 정리 작업 분리 | 미반영 changeset과 export/backup 존재 | 세션 보관·workspace 제거·기록 삭제 요청 | 보관은 파일 삭제 안 함; 삭제 scope/backup 안내·참조 검사 | integration |
| WBTST-036 | WB-MIG-001 | 기존 DB 이관 | 현행 v0.1 DB와 Run/Artifact/startedFrom 존재 | migration 후 기존 링크 열기 | ID·이벤트 불변, Session mapping, 과거 filesystem baseline 발명 안 함 | migration |
| WBTST-037 | WB-MIG-002 | migration 중단 | WAL DB backup과 migration intent 존재 | migration 중 오류 후 재실행 | 검증된 원본/일관된 새 schema 중 하나; 조용한 데이터 손실 없음 | fault |
| WBTST-038 | WB-OBS-001 | 지시 전달 전 생성물 | request Q1 중 Steer 접수·대기 | Q1 결과 후 Q2에 directive 전달 | Q1 결과는 직접 적용으로 표시 안 됨, Q2만 전달 근거 연결 | integration |
| WBTST-039 | WB-OBS-002 | 확인 필요 목록 | 다른 세션에 question/approval/conflict 생성 | sidebar 이동·재접속 | revision에 연결된 항목 유지, 열람만으로 해결 처리 안 됨 | e2e |
| WBTST-040 | WB-DEV-001 | 추적 가능한 변경 | 새 feature PR | 요구·계약·테스트·evidence 검사 | REQ→task→planned test→실행 증거를 구분, 유료 테스트 opt-in | process |
| WBTST-041 | WB-SES-002 | Run 시작 응답 유실 | start가 DB에 확정됐지만 HTTP 응답 유실 | 같은 commandId로 다시 요청 | 기존 Run receipt 반환, Run2 중복 생성 없음 | race |
| WBTST-042 | WB-SES-005 | 대기 요청 이후 외부 변화 | queue plan이 저장된 뒤 target branch/권한 변경 | dispatch 시점 도달 | 최신 의미로 조용히 시작하지 않고 확인 요구 | race |
| WBTST-043 | WB-DIF-001 | 검토 중 최신 revision 수신 | 사용자가 과거 diff를 읽음 | 새 changeset revision 이벤트 | scroll·선택·비교 대상을 유지하고 새 변경 알림 | component |
| WBTST-044 | WB-DIF-002 | 작업 공간 계보 변경 | Session이 worktree A에서 B로 전환 | 세션 전체 비교 | epoch별 표시, 관련 없는 두 상태를 연속 net diff로 합치지 않음 | integration |
| WBTST-045 | WB-DIF-005 | 스캔 중 파일 수정 | 첫 scan 이후 외부 변경 | 후속 확인 scan | unstable 또는 재시도, 강한 snapshot으로 허위 표시 안 함 | race |
| WBTST-046 | WB-WSP-005 | 파일 내용 동일한 외부 변경 | intent after와 동일한 bytes가 외부에 의해 존재 | reconciliation | after 상태 관측과 수행 actor 증명을 구분 | fault |
| WBTST-047 | WB-WSP-003 | 취소가 dispatch보다 먼저 | write plan 기록 후 cancel 확정 | worker가 늦게 쓰기 요청 | fence 거부, 신규 쓰기 없음 | race |
| WBTST-048 | WB-WSP-006 | 프로세스 손자 종료 | test가 child/grandchild를 생성 | 취소·timeout | 지원 OS별 종료 확인; 미확인 시 terminated라고 단정 안 함 | integration |
| WBTST-049 | WB-REV-004 | 반영 중 일부 파일 실패 | 파일 3개 반영 중 2개 완료 | 3번째 파일 쓰기 실패 | partial과 실제 2개 기록; 전체 성공/자동 전량 재시도 아님 | fault |
| WBTST-050 | WB-REV-005 | 반영 0개 취소 | 반영 plan은 있지만 아직 dispatch 없음 | 취소 후 역변경 | 실제 반영 없음을 표시, 불필요한 원본 파일 쓰기 없음 | integration |
| WBTST-051 | WB-REV-002 | feedback submit 응답 유실 | batch 제출·directive 생성 후 HTTP 유실 | 같은 submit command 재시도 | 동일 batch/receipt 반환, 지시 중복 없음 | race |
| WBTST-052 | WB-SEC-001 | Git command injection | 파일 이름에 공백·개행·선행 -·pathspec 문자 존재 | 상태·diff·내용 조회 | argv와 literal parsing으로 명령 실행/다른 path 선택 방지 | security |
| WBTST-053 | WB-SEC-001 | Git hooks/filters trust | repo에 실행 가능한 config·hook/필터 설정 | worktree 준비 시도 | 명시된 trust/정책 검사를 요구, 단순 read처럼 몰래 실행 안 함 | security |
| WBTST-054 | WB-SEC-003 | 공유 export의 secret | 경로·body·환경에 민감 정보 fixture 존재 | 공개 export 수행 | 명시된 제외/검토 정책 적용, 원문 자동 공개 없음 | security |
| WBTST-055 | WB-UX-004 | feed gap | snapshot cursor 뒤 일부 이벤트가 유실 | 재접속 | missing 구간 replay 또는 reset, 오래된 상태를 최신 완료로 표시 안 함 | fault |
| WBTST-056 | WB-UX-006 | Monaco model cleanup | 여러 revision·파일을 반복 열기 | 세션 전환 50회 | 허용한 cache/model 범위로 복귀; 같은 URI로 내용 혼동 없음 | performance |

## 5. Evidence 규칙

증거는 실행 commit, OS/runtime/browser, dependency lock hash, fixture/seed, 실행 명령, exit/result, 알려진 실패·미실행, artifact 경로를 포함한다. 스크린샷은 UI 결과의 보조 증거이며 filesystem 불변성이나 멱등성을 증명하지 않는다.

Live 증거에는 모델/프로필, 호출 수·한도, source workspace와 target 권한, 외부 API opt-in을 남긴다. 실제 지시 준수 평가는 별도 기준에 대해 기록한다. '테스트를 작성했다'와 '통과했다'를 구분한다.

계획 문서 검증기는 요구/태스크/테스트 참조·dependency DAG·Markdown 파일 링크·manifest만 검사한다. 이것으로 제품 API·Git·UI·명령 보안의 검증을 대체하지 않는다.


---

# 근거·설계 결정·확인 필요 항목

## 1. 자료의 우선순위

현재 구현 진단은 아래 기준 커밋의 GitHub 소스가 우선이다. 이전 MVP PDF는 제품의 합의와 범위 이력을 설명하는 자료이며 현재 구현 전체의 증거로 사용하지 않는다. 본 패키지의 개선 구조·상한·일정·성능 목표는 새 설계 제안이다.

기준 저장소: `fromiron/corral`.
기준 커밋: `a9ecda50175e614fe1f559152dd1974e016883e8`.
확인일: 2026-10-16. 앱을 실행하거나 사용자 테스트를 하지는 않았다.

## 2. 저장소 근거

| ID | 확인한 사실/자료 | 원본 |
|---|---|---|
| R01 | 저장소 목적·패키지 구조·기존 v0.2 기능 설명 | [README](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/README.md) |
| R02 | RunOutput이 첫 output artifact를 선택하고 Markdown으로 표시 | [RunView.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/src/components/RunView.tsx) |
| R03 | Artifact의 이전 버전 비교·입력·directive lineage가 이미 존재 | [ArtifactViewer.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/src/components/ArtifactViewer.tsx) |
| R04 | RunSessionStore는 단일 Run view/receipt/stream 상태이며 loadOutput은 첫 결과를 로드 | [run/session.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/src/run/session.ts) |
| R05 | 정의·Run 중심 홈/라우트, graph·tree·detail 중심 RunPage | [router.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/src/router.tsx), [WorkspacePage.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/src/pages/WorkspacePage.tsx), [RunPage.tsx](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/src/pages/RunPage.tsx) |
| R06 | 작업 도구 search/read_document/write_artifact, 출력 계약 text/notes/draft/review, CorralDefinition에 input 포함 | [definition.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/contracts/src/definition.ts) |
| R07 | 기존 후속 기능은 특정 artifact 본문을 새 Run brief로 복사하고 startedFrom을 기록 | [CR-007](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/docs/change-requests/CR-007-new-run-from-version.md) |
| R08 | SQLite의 기존 table·immutable trigger·numbered migration·WAL/FULL/foreign keys | [database.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/storage-sqlite/src/database.ts) |
| R09 | 현재 workspace 아래 .corral/corral.db와 설정 파일 | [workspace.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/server/src/workspace.ts) |
| R10 | Studio가 이미 사용하는 Router/React Flow/React/Zustand/i18n/test 도구 | [Studio package.json](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/apps/studio/package.json) |
| R11 | react-virtual·react-markdown·Storybook·Testing Library 등 기존 의존성 | [React package.json](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/react/package.json) |
| R12 | Coordinator의 단일 결정 경로·effect intent·단일 활성 Run 검사 | [coordinator.ts](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/packages/core/src/coordinator.ts) |
| R13 | 요구·명세·테스트·CR·live opt-in·비밀정보·dependency 검증 규칙 | [AGENTS.md](https://github.com/fromiron/corral/blob/a9ecda50175e614fe1f559152dd1974e016883e8/AGENTS.md) |

R01/R03/R07/R09/R12는 직전 검토에서 같은 고정 커밋을 읽은 자료를 포함한다. 이번에 main이 동일 커밋인지 다시 확인했고, R02/R04/R05/R06/R08/R10/R11/R13을 재조회했다. 모든 원본 기능을 실행해서 확인했다는 뜻은 아니다.

## 3. 외부 1차 자료

| ID | 실제 확인 범위 | 원본 |
|---|---|---|
| S01 | Git worktree의 작업 트리 분리·공유 Git metadata·porcelain 출력 | [Git worktree](https://git-scm.com/docs/git-worktree.html) |
| S02 | Git diff 범위·rename·외부 helper/textconv 제어 | [Git diff](https://git-scm.com/docs/git-diff) |
| S03 | Monaco의 model/URI/dispose·ESM 통합·VS Code 확장과의 차이·mobile 미지원 | [Monaco README](https://github.com/microsoft/monaco-editor/blob/main/README.md) |
| S04 | Monaco 저장소의 MIT license 표기 | [Monaco LICENSE](https://github.com/microsoft/monaco-editor/blob/main/LICENSE.txt) |
| S05 | resizable panels의 layout·keyboard separator·MIT license 표기 | [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) |

외부 자료는 2026-10-16 열람 기준이며 최신 버전 설치·peer compatibility·취약점 검사를 대신하지 않는다. 다른 제품과의 기능 우열·비용 절감·상용 안정성을 증명하는 자료로 사용하지 않았다. 필요한 것은 선정 PR에서 다시 검증한다.

## 4. 제공된 리뷰 문서

F01: `agent-harness-mvp-spec_v1.1.pdf`, 2026-10-14.

- 1쪽: D&D와 실시간 개입을 제품 핵심으로 명시.
- 2쪽: 코딩·파일 동시 수정은 기존 MVP의 제외 범위였음.
- 3쪽: 설계 그래프/실행 호출 트리/협업 기록과 상태 소유 원칙.
- 8–9쪽: 작업·지시·설정의 앞방향 스티어링, 실행 중 graph 구조 변경 제외.

이번 개선은 이 합의를 보존하면서 코딩/파일 작업을 **새 단계의 제안**으로 연다. 과거 MVP가 이미 filesystem 도구를 포함했다고 재해석하지 않는다.

## 5. 핵심 설계 결정 (모두 제안 상태)

| ID | 결정 | 대안과 이유 |
|---|---|---|
| WB-ADR-01 | 사용자 탐색은 Project→Session→Run | 정의/Run만으로는 지속 목적의 재방문이 약함. 내부 execution은 상세로 유지 |
| WB-ADR-02 | Corral/Team과 RunInput 분리 | 매번 목적 수정으로 템플릿이 변하는 문제를 줄임. legacy adapter로 과거 해시 보존 |
| WB-ADR-03 | Workspace를 Project와 분리 | 같은 repo의 작업 복사본·파일 없는 프로젝트를 지원 |
| WB-ADR-04 | Result는 복수의 버전 참조 집합 | 단일 Markdown과 Git patch만의 두 극단을 피함 |
| WB-ADR-05 | native Git + 불변 파일 versions + 관리된 operation 기록 | Git diff 하나로 실행자 귀속·과거 결과를 모두 설명할 수 없음 |
| WB-ADR-06 | 기존 폴더는 먼저 관측만, 쓰기는 managed worktree | 큰 범위를 한번에 열지 않음. Git worktree의 보안 한계는 명시 |
| WB-ADR-07 | 기존 전역 단일 활성 Run 제한 유지 | Session UI와 병렬 쓰기를 동시에 바꾸지 않음. 향후 workspace writer lease로 확장 |
| WB-ADR-08 | Coordinator의 상태 확정 경로 유지 | WorkbenchService를 두 번째 Task/Run 상태 주인으로 만들지 않음 |
| WB-ADR-09 | 새 API와 schema reader는 additive/versioned | 기존 Run·artifact·deep link·보관 기록 보호 |
| WB-ADR-10 | Diff 의견은 batch·version·target에 고정 | 줄마다 자동 실행/최신 파일로 암묵 재부착을 방지 |
| WB-ADR-11 | 승인·반영·복원을 분리 | 취소=rollback, 승인=push 같은 오해를 방지 |
| WB-ADR-12 | Monaco·panel만 우선 추가 | UI 개선 때문에 ORM·런타임·desktop shell 전체를 갈아엎지 않음 |

## 6. 착수 전 확정·검증할 항목

기본안을 다음처럼 정하되, 실제 착수에서 확인한다.

- 첫 파일 쓰기 환경은 Git 기반 trusted managed worktree. 비Git 폴더는 우선 read-only/import다. 비Git 쓰기는 후속 별도 검토.
- 기본 시작 기준은 사용자 선택 commit. dirty overlay 자동 복사 기능은 첫 beta에 넣지 않는다.
- 사용자 결과 리뷰에서 일반 파일 단위 읽음·의견을 먼저 제공하고 hunk 적용/부분 stage는 미룬다.
- 첫 지원 OS는 기존 개발/CI 환경을 확인해 지정한다. 지원하지 않는 OS도 된다고 쓰지 않는다. file/path/process 취소 테스트가 통과한 OS만 쓰기 일반 제공.
- Monaco·panel의 도입 version/license/worker/CSP·기존 Node/React와 호환성은 dependency lock PR에서 확인.
- 기존 `.corral` DB를 app-data로 옮길지는 별도 사용자 동의. 자동 이동하지 않는다.
- scope·크기·성능 budget은 representative fixture 측정 후 정한다. 설계 목표와 측정 결과를 구분한다.

## 7. 알려진 제한

이 문서는 도입 후보를 정했지만 새 코드·schema·Git effect·browser interaction을 실행하지 않았다. read/compare 후 파일 교체는 비협조적 외부 writer와 완전 원자 CAS가 아니다. 실제 검증 명령은 임의 프로젝트 코드를 실행할 수 있다. DB와 filesystem 전체를 한 원자 transaction으로 묶을 수 있다고 가정하지 않는다. 이러한 경계를 지원 문서와 UI에 남기는 것이 이번 개선의 신뢰 계약이다.
