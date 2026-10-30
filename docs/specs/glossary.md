# 용어집

화면 문구·파일명·패널명이 같은 개념을 같은 이름으로 부르도록 정한 기준이다(#92). 화면 이름은 `packages/react/src/messages/{en,ko}.json`의 현재 값이다. 코드·URL 이름은 저장된 주소와 데이터 호환을 위해 그대로 두며, 화면에는 쓰지 않는다.

| 개념 | 화면 이름 (EN / KO) | 코드·URL 이름 | 화면에 쓰지 않는 이름 |
|---|---|---|---|
| 요청과 그 실행을 담는 작업 단위 | Conversation / 대화 | `session`, `/sessions/$id` | 채팅방 |
| 요청 하나로 시작한 처리 | Run / 실행 | `run`, `/runs/$id` | 작업, 잡 |
| 실행 안의 역할별 처리 | Execution / 실행 단위 | `execution` | — |
| 저장한 역할 구성 | Corral(팀) / Corral(팀) | `corral`, `team` | 워크플로 |
| 역할이 쓰는 스킬·확장·도구 선택 묶음 | Work style / 작업 방식 | `harness`, `HarnessProfile` | Harness, 작업 스타일 |
| 모든 프로젝트의 기본 작업 방식 | Personal default work style / 개인 기본 작업 방식 | `defaults`, scope `personal` | Default work style(한정사 없이) |
| 한 프로젝트의 기본 작업 방식 | Project default work style / 프로젝트 기본 작업 방식 | `project-defaults`, scope `project` | Default work style(한정사 없이) |
| 작업 방식이 정해지는 순서 | 개인 기본값 → 프로젝트 기본값 → 팀 역할 → 이번 실행 | `ScopeLadder` | 3단 설명 |
| 실행 결과물 | Results / 결과 | 패널 `artifacts`, 슬래시 `/results` | Artifacts |
| 실행이 쓰는 격리 사본 | Session working copy / 세션 작업 복사본 | `worktree`, scope `session` | 세션 복사본(축약) |
| 연결한 원래 폴더 | Project source folder / 프로젝트 원본 폴더 | `binding`, scope `project` | Linked folder |
| 프로젝트 지침·메모리 기록 | Instructions & memory / 지침·메모리 | `materials`, `ProjectMaterials.tsx` | Project documents, 프로젝트 문서 |
| 편집기로 연 파일 | 문서 탭 | 도킹 `document` | 파일 탭 |
| 도킹 영역의 한 칸 | Pane / 창 | `DockView`, `SessionPanel` | — |
| 응답이 필요한 항목 모음 | Needs you / 확인 필요 | `inbox` | 알림 |
| 실행 일시정지·재개·취소 | Active run controls / 진행 중 실행 제어 | `DockRunControls` | — |
| 모델의 사고량 | Reasoning effort / 추론 노력 | `reasoning` | — |
| 로컬 판정기가 추론 노력을 고르는 설정 | Automatic effort choice / 추론 노력 자동 선택 | `ReasoningSettingsPanel` | Automatic reasoning |
| Git index에 올리기 / 내리기 | Stage / 스테이지, Unstage / 스테이지 해제 | `git.stage`, `git.unstage` | add, 추가(화면 문구) |
| Git 기록 만들기 | Commit / 커밋 | `git.commit` | 저장(문서 저장과 구분) |
| 원격에서 받기 / 반영 / 보내기 | Fetch / 가져오기, Pull / 당겨오기, Push / 올리기 | `git.fetch`, `git.pull`, `git.push` | 동기화(범위가 다름) |
| 사람이 시작한 package script 실행 | Task / 작업 | 메시지 `DevTasks`, operation `task` | 명령(Run이 실행한 명령과 구분) |
| task·미리보기를 다루는 창 | Tasks & preview / 작업·미리보기 | 패널 `tools`, 슬래시 `/preview` | Running commands & preview, 도구 |
| 검사·task 출력의 위치 목록 | Problems / 문제 | 패널 `problems`, 슬래시 `/problems` | Diagnostics, 진단 |
| 현재 의도가 싣지 않는 항목 | Applies to a new request only / 새 요청에만 적용 | `heldForNew` | 항목별 개별 안내 |

기본 프로젝트의 표시 이름은 예약 선택기와 프로젝트 탐색에서 같은 지역화 값을 사용한다. 실행 비교의 복귀 링크는 실제 이동 대상인 프로젝트 홈을 가리킨다. 팀 편집기의 두 revision은 팀 구성 버전과 화면 배치 버전으로 구분해 표시한다. 반영 뒤 외부에서 바뀐 파일을 되돌리지 않은 결과는 변경 시점과 보존한 이유를 함께 설명한다.

## 파일명

- `pages/McpConnection.tsx`는 MCP 서버 한 개의 연결 위젯이고, `pages/McpSettingsPage.tsx`가 설정 화면이다.
- `workbench/ProjectMaterials.tsx`는 서버의 지침·메모리 기록을 다루며 작업 폴더 파일과 무관하다.

## 남은 불일치

- EN 화면은 같은 개념을 "conversation"과 "session"으로 섞어 쓴다(예: Filter conversations / Rename session). 한쪽으로 맞추는 일괄 변경은 별도 작업이다.
- 화면 문구에 "pane"과 "panel"이 섞여 있다(예: Close pane / Show the panel). "panel"은 옆·아래 영역 전체를 가리키는 곳에 남아 있다.
- 실행 상태 어휘가 `RunStatus`·`Status`·`RunPage`·`RunReasons` 네임스페이스에 나뉘어 있다.
