# 용어집

화면 문구·파일명·패널명이 같은 개념을 같은 이름으로 부르도록 정한 기준이다(#92). 화면 이름은 `packages/react/src/messages/{en,ko}.json`의 현재 값이다. 코드·URL 이름은 저장된 주소와 데이터 호환을 위해 그대로 두며, 화면에는 쓰지 않는다.

| 개념 | 화면 이름 (EN / KO) | 코드·URL 이름 | 화면에 쓰지 않는 이름 |
|---|---|---|---|
| 요청과 그 실행을 담는 작업 단위 | Conversation / 대화 | `session`, `/sessions/$id` | 세션·session(이 뜻으로), 채팅방, 작업 보드, Task board, 백로그 |
| 요청 하나로 시작한 처리 | Run / 실행 | `run`, `/runs/$id` | Execution(이 뜻으로), 작업, 잡 |
| 실행 안의 역할별 처리 | Execution / 실행 단위 | `execution` | 실행·Run(이 뜻으로) |
| 저장해 두고 다시 쓰는 역할 구성 | Corral / Corral | `corral`, `/library/teams` | 팀·team(저장한 구성의 이름으로), 워크플로 |
| 여러 역할이 함께 일하는 구성을 이르는 보통명사, 그래프에서 단계를 묶는 상자 | team·Team / 팀 | 상자 `team` | — |
| 편집기의 단계 종류 | 팔레트의 이름 그대로. Loop는 두 언어 모두 Loop | `TeamEditor.kinds` | 루프, 국문 문장 속의 Team·Join·Output |
| 역할이 쓰는 스킬·확장·도구 선택 묶음 | Work style / 작업 방식 | `harness`, `HarnessProfile` | Harness, 작업 스타일 |
| 모든 프로젝트의 기본 작업 방식 | Personal default work style / 개인 기본 작업 방식 | `defaults`, scope `personal` | Default work style(한정사 없이) |
| 한 프로젝트의 기본 작업 방식 | Project default work style / 프로젝트 기본 작업 방식 | `project-defaults`, scope `project` | Default work style(한정사 없이) |
| 작업 방식이 정해지는 순서 | 개인 기본값 → 프로젝트 기본값 → Corral 역할 → 이번 실행 | `ScopeLadder` | 3단 설명, 팀 역할 |
| 실행 결과물 | Results / 결과 | 패널 `artifacts`, 슬래시 `/results` | Artifacts |
| 실행이 쓰는 격리 사본 | Conversation working copy / 대화 작업 사본 | `worktree`, scope `session` | 세션 작업 사본, 세션 복사본, 작업 복사본 |
| 연결한 원래 폴더 | Project source folder / 프로젝트 원본 폴더 | `binding`, scope `project` | Linked folder |
| 프로젝트 지침·메모리 기록 | Instructions & memory / 지침·메모리 | `materials`, `ProjectMaterials.tsx` | Project documents, 프로젝트 문서 |
| 편집기로 연 파일 | 문서 탭 | 도킹 `document` | 파일 탭 |
| 도킹 영역의 한 칸 | Pane / 창 | `DockView`, `SessionPanel` | — |
| 응답이 필요한 항목 모음 | Needs you / 확인 필요 | `inbox` | 알림 |
| 실행이 사람의 답을 기다리는 상태 | Waiting for you / 응답 대기 | run status `awaiting_user` | 결정 대기, Response needed / 응답 필요, Waiting for your answer / 답변을 기다리고 있습니다, 내 답변 대기, 답을 기다리는 중, 사용자를 기다리는 중 |
| 그 상태에 답하러 가는 동작 | Respond / 응답하기 | 대화 안내, 실행 기록 머리, 확인 필요 | Check now / 확인하기, Go to the request / 요청으로 이동 |
| 다시 쓰는 팀·템플릿·리소스 모음 | Library / 라이브러리 | `/library`, `features/library.md` | 자료실 |
| 예약 실행 화면 | Automation / 자동화 | `/schedules`, `ScheduledPage` | 스케줄러 |
| 프로젝트 대화 탭의 상태별 배치 | Needs attention / 확인 필요, Review / 검토, In progress / 진행 중, No run yet / 실행 전, Completed / 완료, Cancelled / 취소됨, Empty conversation / 빈 대화 | `sessionGroups` | Task status, To do, In review, Done |
| 대화의 일이 끝났다고 볼 조건 목록 | Completion criteria / 완료 기준 | `WorkSession.criteria`, run input `criteria` | Definition of done, 체크리스트, 기준 충족 |
| 샘플 데이터로 보이는 미구현 흐름 | Feature preview / 기능 미리보기 | `/preview`, `feature-preview` | 데모(시뮬레이션 실행과 구분) |
| 프로젝트의 원본 폴더·작업 사본 보기 | Environment / 환경 | 프로젝트 탭 `environment` | 작업 환경 설정 |
| 경로로 파일 찾아 열기 | Quick open / 빠른 열기 | `quickOpen` | 파일 검색(내용 검색과 구분) |
| 대화의 검사 명령 기록 | Checks / 검사 | `verifications` | 검증됨(통과 보장처럼 읽힘) |
| 실행 상태와 일시정지·재개·중지를 한 줄로 보이는 컴포저 위의 줄 | Activity bar / 활동 바 | `ActivityBar` | 실행 조작 알약, 한 줄 상태, 진행 중 실행 제어 |
| 앱 전체의 색 구성 선택 | Appearance / 화면 테마 | `theme`(밝기), `palette`(이름 있는 테마) | 스킨, 컬러 스킴 |
| Corral이 함께 싣는 색 구성 | Built-in theme / 내장 테마 | `builtin:<id>` | 프리셋, 기본 테마(시스템·라이트·다크와 구분) |
| 이 기기에서 만든 색 구성 | Personal theme / 개인 테마 | `custom:<id>` | 커스텀 테마, 사용자 정의 테마, 내 테마 |
| 모델의 사고량 | Reasoning effort / 추론 노력 | `reasoning` | — |
| 자동 추론 요청의 수준을 판정 엔진이 고르는 설정 | Effort mode / 추론 판정 | `EffortRoutingSettings` | Automatic reasoning, 추론 노력 자동 선택 |
| Git index에 올리기 / 내리기 | Stage / 스테이지, Unstage / 스테이지 해제 | `git.stage`, `git.unstage` | add, 추가(화면 문구) |
| Git 기록 만들기 | Commit / 커밋 | `git.commit` | 저장(문서 저장과 구분) |
| 원격에서 받기 / 반영 / 보내기 | Fetch / 가져오기, Pull / 당겨오기, Push / 올리기 | `git.fetch`, `git.pull`, `git.push` | 동기화(범위가 다름) |
| 사람이 시작한 package script 실행 | Task / 작업 | 메시지 `DevTasks`, operation `task` | 명령(Run이 실행한 명령과 구분) |
| task·미리보기를 다루는 창 | Tasks & preview / 작업·미리보기 | 패널 `tools`, 슬래시 `/preview` | Running commands & preview, 도구 |
| 검사·task 출력의 위치 목록 | Problems / 문제 | 패널 `problems`, 슬래시 `/problems` | Diagnostics, 진단 |
| 현재 의도가 싣지 않는 항목 | Applies to a new request only / 새 요청에만 적용 | `heldForNew` | 항목별 개별 안내 |
| 진행 중인 실행 단위의 다음 모델 요청에 실리는 전송 | Join / 합류 | 지시 `delivery: next_request`, intent `steer` | 대화 화면의 지시·Instruction(실행 화면의 지시 영역은 [Reins](features/reins.md)의 낱말 Instruction / 지시를 쓴다), Steer |
| 흐르는 응답을 끊고 바로 실리는 전송 | Interrupt / 끼어들기 | 지시 `delivery: interrupt` | 중단(실행을 끝내는 것과 구분), 강제 전달 |
| 진행 중인 실행이 끝난 뒤 시작할 전송 | Next request / 다음 요청 | intent `queue`, 항목 state `queued` | 큐, 예약 |
| 합류·끼어들기가 향하는 실행 단위 | Target / 대상 | `targetExecutionId` | 수신자(회의의 수신자와 구분) |
| 그 메시지를 실은 요청이 시작됨 | Read / 읽힘 | 지시 상태 `delivered` | 전달됨(대화 화면에서), 반영됨, 적용됨 |
| 읽히지 못하고 끝난 메시지나 조언 | Not delivered / 전달되지 않음 | 지시 상태 `expired`·`not_delivered` | 전달 안 됨 |
| 읽히지 못한 합류 메시지를 서버가 대기 요청으로 바꾸는 일 | Carried over / 넘겨받음 | `carriedFrom` | 재전송(사람이 누르는 다시 보내기와 구분) |
| 타임라인 끝의 응답 자리 | Needed now / 지금 필요한 것 | `PendingTray` | 대응 필요 알림, 응답 영역(실행 기록에서) |
| 실행·실행 단위·대화가 화면에 보이는 상태 | — (낱말은 [표시 상태](features/presence.md)의 표) | `presence`, 메시지 `Presence` | — |
| 다른 역할을 지켜보다가 조언하는 역할 | Advisor / 감독 | `invocation: observer` | 워치독, 리뷰어(검토 Decision과 구분), 감시자 |
| 감독이 대상에게 하는 말 | Advice / 조언 | `advice`, 지시 `origin: advice` | 경고, 피드백 |
| 조언의 심각도 | Note / 참고, Concern / 우려, Blocker / 중단 권고 | `nit`, `concern`, `blocker` | — |
| 답변의 일부를 골라 요청에 싣는 일 | Quote / 인용 | 첨부 출처 `reply`, 단축키 `reply.quote` | 발췌, 스니펫 |
| 사람이 계속할지 정하는 응답 | Continue? / 계속 여부 | 무진전 승인, 회의 `hold` | 한도 초과(끝난 것처럼 읽힘) |

기본 프로젝트의 표시 이름은 예약 선택기와 프로젝트 탐색에서 같은 지역화 값을 사용한다. 실행 비교의 복귀 링크는 실제 이동 대상인 프로젝트 홈을 가리킨다. 반영 뒤 외부에서 바뀐 파일을 되돌리지 않은 결과는 변경 시점과 보존한 이유를 함께 설명한다.

## 파일명

- `pages/McpConnection.tsx`는 MCP 서버 한 개의 연결 위젯이고, `pages/McpSettingsPage.tsx`가 설정 화면이다.
- `workbench/ProjectMaterials.tsx`는 서버의 지침·메모리 기록을 다루며 작업 폴더 파일과 무관하다.

## 설명이 붙는 용어

제품이 지은 이름이라 낱말만으로 뜻을 알 수 없는 용어다. 화면은 아래 자리에서 뜻을 한 문장으로 보인다. 형태와 동작은 [용어 설명](features/term-hints.md)이 정하고, 이름과 뜻의 문구는 메시지 `Terms`에 있다.

| 용어 (EN / KO) | 메시지 | 설명이 붙는 자리 |
|---|---|---|
| Corral / Corral | `Terms.corral` | 라이브러리의 Corral 탭(툴팁), 컴포저 도구 줄의 Corral 선택(툴팁) |
| Execution / 실행 단위 | `Terms.execution` | 편집기 실행 창의 실행 단위 목록 제목(아이콘) |
| Work style / 작업 방식 | `Terms.workStyle` | 설정의 작업 방식 화면 제목(아이콘), 편집기 Inspector의 작업 방식 이름표(아이콘) |
| Advisor / 감독 | `Terms.advisor` | 컴포저 도구 줄의 감독 버튼(툴팁) |

Loop와 편집기의 다른 단계 종류는 팔레트가 이름 옆에 뜻을 보이므로 여기에 넣지 않는다. Reins는 명세와 코드의 이름이고 화면에는 나오지 않는다(실행 화면의 그 영역은 "지시하기"와 "실행 제어"로 부른다).

## 남은 불일치

- "Corral"은 제품의 이름이면서 저장한 역할 구성의 이름이다. 제품을 가리킬 때는 문장의 주어나 장소로만 쓰고("Corral은 녹음을 저장하지 않습니다"), 저장한 구성을 가리킬 때는 고르고 만들고 지우는 대상으로 쓴다.
- "Join / 합류"는 편집기의 단계 종류이면서 컴포저의 전송 방식이다. 두 이름은 다른 화면에서만 나온다.
- 아래는 한 개념에 이름이 여럿이거나 한 이름에 뜻이 여럿인 채로 남아 있다. 이름을 정하면 이 표에 행을 더하고 여기서 지운다.
  - 실행에 주는 요청 글(Brief): 국문이 지시문·브리프·요청·요청서로 갈린다.
  - Decision: 국문이 판정·판단·결정으로 갈린다(그래프의 판단 노드, 검토의 판단, 승인의 결정이 섞인다).
  - 하위 실행 단위: child execution·helpers·sub-tasks·delegated tasks, 하위 실행·보조 실행·하위 작업·위임한 작업.
  - 기다리는 요청: Queued·queue, 대기열·대기 중·대기 요청. "Next request / 다음 요청"과의 경계가 정해지지 않았다.
  - Output / 출력: 출력 노드, 실행의 Output 탭, 출력 계약, 검사·프로세스·터미널의 출력.
  - Instructions: 역할의 프롬프트, 실행 단위에 보내는 지시, 프로젝트 지침.
  - `Docking.conversation`과 `Docking.chat`은 같은 값을 가진 두 키다.
  - Pane: 국문이 "창"과 "패널"로 갈린다. "창"은 운영체제 창의 이름이기도 하다("창 최대화").
  - 저장하지 않고 쓰는 자동 구성: 컴포저는 "Auto / 자동", 새 대화 만들기와 대화 메뉴는 "Default chat / 기본 대화"라고 부른다.
- 실행 상태의 낱말은 [표시 상태](features/presence.md)의 것 하나로 쓰지만, 문구 키는 `Presence`·`RunStatus`·`Status`·`RunPage`·`RunReasons`·`Events` 네임스페이스에 나뉘어 있다. 낱말을 바꿀 때는 이 여러 곳을 함께 고친다.
