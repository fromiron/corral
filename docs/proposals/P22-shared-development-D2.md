# P22 D2 결정 자료 — 개발 서버를 켠 채 저장하기

- 작성: 2026-10-23. **2026-10-23 사용자가 B안과 §3을 그대로 승인했다. 승인 기록은 [CR-046 P22](../change-requests/CR-046-development-workbench.md#p22-공유-개발-owner-d2-승인)에 있다.** 아래는 결정 당시의 자료다. 사용자가 아래 선택지 중 하나를 명시적으로 승인하기 전에는 구현하지 않는다. 승인 전에는 strict 동작을 유지한다.
- 근거: [활성 계획](../plans/workbench-development-implementation-plan-2026-10-21.md)의 D2·WB-P22와 “2026-10-23 P17 이후 재검토 반영”, [CR-046](../change-requests/CR-046-development-workbench.md) 계약 6과 P15.
- 이 문서는 정본이 아니다. 승인되면 CR-046(또는 새 CR)·요구·backlog·test catalog에 옮긴 뒤 이 문서를 지운다.

## 1. 문제

일반적인 웹 개발 루프는 다음과 같다. 개발 서버(`pnpm dev`)를 켠 채 파일을 고쳐 저장하면 HMR이 화면을 갱신한다. Corral의 strict 모드에서는 이 루프가 막힌다.

- 관리 사본 하나에는 writer 예약이 하나뿐이다(`workspace_access`, canonical path 기준). Run, 터미널(PTY), 개발 task가 같은 예약을 공유한다.
- 사용자가 시작한 task와 터미널은 살아 있는 동안 writer를 계속 잡는다(인간 operation `task`·`terminal`).
- 그동안 같은 사본의 문서 저장은 `RUN_ALREADY_ACTIVE`(409)로 거절된다. P15는 “작업 중지 → 정리 확인 → 저장 → 다시 시작” 경로를 붙였다. 이 경로는 복구 수단이지 live edit 지원이 아니다.
- 검사는 예외다. 그 시점 tree의 snapshot에서 실행되므로 task·터미널이 writer여도 돌 수 있다(`writerBlocksCheck`). Run writer와 짧은 인간 변경 중에는 여전히 막힌다.

결과적으로 “서버를 켠 채 수정·저장·화면 확인”은 매번 서버를 멈춰야 한다. P20(preview 피드백)과 P23 이후 일상 개발 기능을 완성으로 선언하려면 이 결정이 먼저 필요하다.

## 2. 선택지

| | A. strict 유지 | B. 공유 개발 owner (권고) | C. 실행용 사본 분리 | D. 제한 없는 공유 |
|---|---|---|---|---|
| 요지 | 지금처럼 writer 하나. 중지→저장→재시작 | 한 사본에서 **사람의 편집과 사람이 명시한 dev task**만 한 개발 owner 아래 함께 쓴다 | dev server는 별도 사본에서 돌고 저장 내용을 그쪽에 동기화 | 사람·터미널·여러 agent가 동시에 쓴다 |
| 일상 개발 루프 | 불가(매번 재시작) | 가능 | 가능(동기화 지연) | 가능 |
| agent 쓰기와의 관계 | 기존 그대로 | 같은 사본의 agent writer·checkout·merge/rebase는 개발 owner를 끝내거나 명시적으로 넘긴 뒤에만 | agent는 원래 사본, 서버는 별도 사본 | 섞임. 귀속 불가 |
| 새 위험 | 없음 | dev task가 소스를 바꿀 수 있음(codegen, formatter 등). strict 격리라고 부를 수 없음 | 사본 두 개의 동기화·충돌·디스크 사용, “화면이 어느 tree인가” 불명 | 파일 CAS 충돌, 귀속 붕괴, 검토 근거 상실 |
| 구현 범위 | 없음 | 중간(owner 모드·전환·표시·검사 snapshot 경계) | 큼(동기화 엔진, 두 사본 수명) | 작지만 계약 대부분 무효 |
| 기존 계약 영향 | 없음 | CR-046 계약 6을 “선택 모드”로 확장 | 새 사본 종류 | 계약 3·6 폐기에 가까움 |

**권고: B.** 재검토 문서(§11)와 원래 계획(WB-P22)의 권고와 같다. 사용자가 이미 쓰는 개발 방식에 가장 가깝다. agent의 구조 변경과 검토·검사 근거는 지금의 경계를 유지할 수 있다. C는 B로 부족하다는 실제 관찰이 있을 때 다시 검토한다. D는 권하지 않는다.

## 3. B를 승인할 때 함께 정해야 할 의미

재검토 문서가 “반드시 먼저 정할 의미”로 꼽은 항목에 대한 제안이다. 각 항목을 승인하거나 고쳐 주면 계약으로 옮긴다.

1. **모드와 owner의 저장·복구**
   - 사본마다 `mode: strict | shared_development`를 서버 원장(`session_worktrees` 또는 workspace access)에 저장한다.
   - 공유 모드는 하나의 개발 owner(인간 operation `development`)가 잡는다. 사람의 저장과 사람이 시작한 task는 그 owner의 하위 효과로 접수한다.
   - 서버를 다시 시작하면 열린 개발 owner는 `uncertain`이 된다. 공유 모드를 자동으로 다시 열지 않는다(아래 6).
2. **agent writer를 시작할 때**
   - 같은 사본에 agent writer(Run의 `write_file`·편집 도구)나 checkout·branch 전환·merge/rebase를 시작하려 하면 거절하고 이유를 보인다.
   - 사람은 둘 중 하나를 고른다. ① 개발 owner를 끝낸다(task 중지·정리 확인) ② 명시적으로 넘긴다(공유 모드를 끝내고 strict로 돌아감).
   - 자동 인계는 없다. 읽기 전용 Run과 검사는 지금처럼 고정 snapshot을 쓴다.
3. **파일 충돌과 외부 쓰기**
   - 저장은 지금의 CAS(base hash) 그대로다. dev task가 같은 파일을 바꿨으면 디스크 충돌로 보이고 초안을 보존한다.
   - 감시가 놓친 쓰기는 다음 읽기·저장 때 hash로 드러난다. 놓쳤을 수 있는 구간은 “외부 변경 가능”으로 표시하고 귀속은 `external_observed`/`mixed`를 쓴다(P17).
4. **snapshot 경계**
   - 검사·검토·Git 보기는 모두 그 시점 tree snapshot을 기준으로 한다(P17의 tree·설정 유효성 표시를 그대로 쓴다).
   - Git stage/commit은 공유 모드에서도 Git 창 한 곳이다. 실행 순간의 index를 기준으로 하고, 진행 중 dev task가 바꾼 파일은 commit 확인 화면에서 변경됨으로 보인다.
5. **source version과 copy generation**
   - `copyGeneration`은 사본 identity다. 사본을 다시 만들 때만 올린다. 저장할 때마다 올리지 않는다.
   - 파일 내용의 변화는 tree·hash로 구분한다.
6. **재시작 정책**
   - host가 다시 시작하면 기록된 task process group이 살아 있어도 자동으로 재실행하거나 grant를 조용히 복원하지 않는다.
   - 사라진 것을 확인하면 정리한다(P15와 같음). 공유 모드도 사람이 다시 켠다.
7. **범위 밖(첫 승인에 넣지 않음)**
   - 무제한 사용자 셸과 여러 agent의 동시 쓰기.
   - 원본 폴더에서의 공유 모드.
   - 원격 host(P21-B/C-135 검증 전).

## 4. 화면에서 보이는 것(B 기준)

- 사본 머리(Changes·Tasks & preview)에 모드를 한 곳에 표시하고 전환한다. 공유 모드에서는 “strict 격리 아님”을 짧게 밝힌다. 레이아웃이 이미 설명하는 반복 문구는 넣지 않는다.
- 저장이 거절되던 자리(P15 `WriterHeld`)에는 strict에서만 “작업 중지 후 저장”이 나온다. 공유 모드에서는 저장된다.
- agent 실행 시작이 막히면 Composer의 기존 거절 표시에 “개발 모드 끝내기”를 붙인다. 새 관리창은 만들지 않는다.

## 5. 승인 뒤 완료 조건과 시험(초안)

- H: 서버를 켠 채 수정·저장·HMR 갱신이 된다. dev task가 같은 파일을 바꾸면 초안을 보존하고 충돌로 보인다. 검사 결과는 실행 snapshot에 묶이고, 이후 변경은 “이전 상태”로 보인다.
- N: 공유 모드에서 agent writer, checkout, merge/rebase는 handoff 전 거절된다. 저장할 때 copyGeneration이 그대로다. 원격 host와 원본 폴더에서는 공유 모드를 켤 수 없다.
- F: host 재시작 뒤 공유 모드와 task가 자동으로 되살아나지 않는다. strict로 돌아갈 때 후손 프로세스 종료를 확인하고, 확인하지 못하면 uncertain을 유지한다. 감시 누락 구간의 귀속은 불확실로 표시한다.
- 실제 앱 확인: fixture의 Vite/Node 개발 서버를 켠 채 저장했을 때 preview 프레임이 갱신되는지(P20-A와 함께).

## 6. 결정 요청

다음 중 하나를 알려 주세요.

1. **B 승인**: 위 3의 의미를 그대로 또는 고쳐서 승인한다. 그러면 CR을 갱신하고 red 시험부터 구현한다.
2. **A 유지**: 일상 개발 UX 문서에 “개발 서버 재시작 필요”를 제한으로 명시하고 P20·P23을 그 전제로 진행한다.
3. **C 검토**: 별도 비교(동기화 방식·디스크·지연)를 먼저 만든다.

결정 전에도 P21-A, P23, P24-A처럼 이 결정과 독립인 작업은 진행할 수 있다(재검토 순서 R4의 조건).
