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
