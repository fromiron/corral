# CR-020: 항목 반복·MCP·codemode·LSP 변경 제안 (R3)

현재 상세 기준: [하네스 상세 계약](../current/harness-contract.md). 아래 원래 계획의 Git 참조는 승인 경위이며 현재 작업 목록은 [활성 계획](../plans/README.md)이다.

- 상태: 구현·로컬 검증 완료, 2026-10-18. [검증 보고서](../evaluation/Personal-Harness-Validation-2026-10-18.md).
- 기준: 개인 하네스 구현 플랜 H7–H8, CR-018·019.
- 항목별 작업은 분리된 입력과 부모 Run 예산·취소를 사용한다. 중첩 Loop 금지와 기존 위임 깊이를 보존한다. 같은 작업 복사본의 병렬 변경은 허용하지 않는다.
- Pi 1.3.0 공개 MCP/codemode 확장을 명시적으로 활성화한다. 중첩 호출도 최종 인자 승인과 실행 직전 검사를 거친다. 전 세션 codemode worker 상한은 2다. MCP 서버 실행과 인증은 명시적 신뢰 대상이다.
- LSP rename/code action은 workspace edit 제안으로 보관한다. 적용 전 모든 대상의 경로·버전·원본 hash를 검증하며 파일 broker로만 적용한다. stale·불완전 적용을 성공으로 보고하지 않는다.
- 리소스·정책·검증 기준은 실행 중 임의 교체하지 않는다. native 확장은 sandbox가 아니며 직접 fs/network/process 효과를 중개한다고 보장하지 않는다.

## 반례·완료 조건

TC-HAR-015: 항목 간 입력 누출, 중첩 상한 우회, 부모 취소 후 다음 항목 시작, 동일 worktree 동시 쓰기 거절.
TC-HAR-016: MCP unknown tool·인자 변조·취소·수명 정리, 인증정보 비노출.
TC-HAR-017: codemode 중첩 승인·거절·worker 상한·취소 및 부모 예산 귀속.
TC-HAR-018: LSP 응답과 문서 버전 불일치, 범위 밖 URI, 부분 실패. 적용은 명시적 사용자 동작이다.
실제 네트워크 서버나 사용자 자격 증명을 일반 CI에서 사용하지 않는다.

## H7 항목 실행 의미

기존 `spawn_subagents`의 선택 인자 `mode: "items"`를 사용한다(생략은 기존 병렬 동작). 1–4개의 `{targetNodeId, brief}`를 순서대로 처리하고 각 항목의 task ID·상태·제출 버전을 반환한다. 새 그래프 노드나 별도 workflow 엔진은 없다.

- 항목마다 새 Task/Execution을 만든다. `item: {batchId, index, total}`로 실행 기록과 화면에서 구별한다. batchId는 승인된 toolCallId이며 index는 1부터 시작한다.
- 항목 입력에는 해당 brief와 고정 완료 기준만 넣는다. 대상 노드의 run brief/다른 task/이전 Loop 출력 binding을 자동 합치지 않는다. 자손도 같은 항목 경계를 이어받으며 명시적으로 전달받은 입력만 읽는다. 앞 항목의 출력·대화·파일 읽기 근거를 빌릴 수 없다. 작업 파일 자체는 같은 사본에 순서대로 누적된다.
- 첫 항목 전에 기존 자손/다른 병렬 실행이 남아 있으면 거절한다. 부모는 waiting_children 상태로 모델 슬롯을 놓는다. 한 항목의 자손까지 정리돼야 다음 항목이 시작된다. 항목 내부 추가 위임은 한 번에 하나만 가능하며 기존 깊이·Run spawn/모델/토큰 한도를 적용한다. 중첩 항목 batch는 금지한다. Loop 구조 제한은 바뀌지 않는다.
- 항목 하나가 실패·취소되면 남은 항목은 시작하지 않는다. 마지막 결과에 시작하지 못한 개수를 남기며 이미 생성된 Task 기록은 유지한다. 중복 executeTool 요청은 기존 once fence를 따른다. 부모 취소·종료·pause 뒤 다음 항목을 자동 시작하지 않는다(pause 해제 뒤 재검사).

## 필수 확장 실패 경계

필수 확장의 초기화뿐 아니라 실행 중 hook 오류도 해당 execution의 실패다. Pi가 오류를 알린 뒤 같은 요청에서 다음 도구나 모델 전송으로 계속하지 않는다. 이미 실행한 효과는 기록을 유지하며 되돌린 것으로 표시하지 않는다. 오류 본문·로컬 확장 경로는 공개 로그에 넣지 않는다. 선택 확장 오류는 별도로 다루며 이 규칙으로 필수 상태를 대신하지 않는다.

## 런타임 도구 등록

Pi 공개 runtime의 `refreshTools`와 로드 결과의 extension 도구 정의를 사용한다. 최초 로드 보고 이후의 등록/교체/제거는 execution별 증가 revision으로 Coordinator에 보고한 뒤 도구 호출이나 모델 요청을 계속한다. 보고는 원래 snapshot hash와 기대 revision을 확인하고 기존 역할 allowlist를 넓히지 않는다. 승인 시의 descriptor hash를 실행 직전 재검사하여 교체된 스키마/출처의 이전 승인을 재사용하지 않는다. 이미 시작한 효과는 원래 소유권으로 정산한다.

중첩 호출은 Pi의 `parentToolCallId`를 현재 실행 중인 Corral 도구 ID로 변환한다. 같은 execution에서 아직 열린 native 효과만 부모가 될 수 있다. 부모 종료 뒤의 승인·실행은 거절하고 호출 기록에 부모 ID를 남긴다. worker의 Pi ID나 임의의 다른 execution ID를 신뢰하지 않는다.

## codemode 실제 worker 종료

Pi 1.3.0의 codemode 결과와 `sandbox.close()`는 Worker의 OS 종료보다 먼저 반환할 수 있다. 따라서 호출 완료 개수를 worker 수로 취급하지 않는다. 이미 공개된 pi-codemode의 `onWorkerStarted(exited)` 관찰자를 pi-coding-agent의 공식 factory 옵션까지 전달하는 최소 버전 고정 patch를 사용한다. Coordinator가 생성 전 capacity를 예약하고 SDK wrapper가 실제 exit를 확인한 뒤 반환한다. SDK 프로세스 종료가 확인되면 소유 lease를 정리하며 종료 미확인 상태에서는 반환하지 않는다. 새 실행 엔진·Worker monkey patch·Pi 내부 카운터 조회는 추가하지 않는다. 정확한 적용 파일/검증은 의존성 원장에 남기고 버전 변경 때 patch 재검증을 요구한다.

SDK worker는 실행 시작 IPC를 보내기 전에 private 프로세스 소유 기록을 저장한다. 백엔드는 workspace 소유 lock을 얻고 이전 worker의 종료를 확인한 뒤 Coordinator를 시작한다. Linux에서는 boot ID와 `/proc` 시작 시각을 확인하여 PID 재사용을 구분하고 같은 소유 process group만 종료한다. 확인할 수 없으면 새 실행을 막는다. 다른 OS에서는 이전 PID가 아직 살아 있으면 자동으로 다른 프로세스를 죽이지 않고 복구 미확인으로 시작을 거절한다. `error` 이벤트만으로 살아 있는 child의 종료를 확정하지 않는다.

그룹 leader가 이미 사라진 경우에는 PGID만으로 소유권을 확정하지 않는다. 새 SDK/MCP 프로세스에 실행별 무작위 소유 표지를 환경으로 전달하고 private lease에 함께 저장한다. 살아 있는 같은 그룹 구성원이 표지를 보존한 경우만 정리한다. 표지가 없는 과거 기록이나 확인 불가 그룹은 cleanup unconfirmed이며 다른 프로세스를 추정으로 종료하지 않는다.

## MCP 설정·권한·인증

- `ProjectToolConfigRevision.mcpServers`에 stdio argv 또는 HTTP endpoint, 노출 방식(direct/codemode), timeout, 인증 방식/credential reference/요청 scope를 저장한다. 기존 revision은 선택 필드가 없어도 동일한 hash를 유지한다. 서버 ID는 도구 namespace 충돌을 피하도록 소문자 영숫자와 밑줄로 제한한다.
- 역할은 `mcpServerIds`와 구체적 `allowedTools`의 교집합을 선택한다. Run snapshot은 프로젝트 설정 revision/hash와 선택 ID를 고정한다. 실행/원격 endpoint 신뢰는 `kind=mcp`인 개별 fingerprint에 부여한다. HTTP fingerprint는 원격 코드의 불변성을 증명하지 않으며 endpoint·인증 대상·scope에 대한 신뢰다. stdio는 기존 launch fingerprint를 사용한다.
- SDK의 공개 `createMcpExtension` factory만 활성화하고 설정 파일 자동 탐색·확장의 미등록 서버 연결·내장 `/mcp` 설정 변경 경로를 막는다. 실제 관리 사본 cwd를 private IPC로 전달하며 사용자 원본 cwd를 대체 실행 위치로 쓰지 않는다. native 서버 자체는 OS sandbox가 아니다.
- Bearer/OAuth 비밀과 갱신 토큰은 workspace 밖의 Corral private 저장소에 둔다. OAuth는 공개 pi-mcp flow와 loopback PKCE callback을 사용하고 사용자 설정 화면에서만 시작/취소한다. worker는 고정 서버 ID로 해당 요청에 필요한 bearer token만 host에 요청한다. 권한 scope 변경·다른 endpoint에 기존 credential을 재사용하지 않는다. 임의 provider key 조회나 모델 자격 증명 전달을 허용하지 않는다.
- SDK native descriptor/중첩 호출 경계를 MCP에도 적용한다. 종료 시 `session_shutdown`으로 서버 연결을 닫고 worker 프로세스 정리도 확인한다. 일반 CI/로컬 검증은 로컬 MCP·OAuth fixture만 사용한다.

## LSP 변경 제안의 적용 의미

- 기존 `lsp_query`에 `rename`(위치·새 이름)과 `code_actions`(범위·선택적 kind)를 추가한다. 읽기 질의와 같은 등록 서버·고정 설정·launch 승인 경로다. 서버의 `workspace/applyEdit` 요청은 계속 거절한다.
- 서버는 기존 UTF-8 파일의 TextEdit/버전 있는 TextDocumentEdit를 제안할 수 있다. 열어 동기화한 문서는 version 1만 인정하고 다른 문서는 version null이어야 한다. 경로·원본 hash·전체 작업 tree를 확인한다. 겹치는 edit, 잘못된 UTF-16 위치·서로게이트 분할, 미지원 resource operation/annotation/snippet은 거절한다. 코드 액션의 command 실행은 하지 않는다. edit가 없는 지원 불가 액션은 이유를 표시한다.
- 제안은 ID·본문 hash·소유 run/execution/attempt/effect·기준 tree·설정 revision·서버 fingerprint와 함께 불변 보관한다. diff 본문은 로컬 파일 검토 API에서만 읽고 이벤트/공개 export에는 넣지 않는다. 제안 생성만으로 파일이 바뀌거나 agent 읽기 원장이 생기지 않는다.
- 사용자가 세션 파일 검토 화면에서 제안 hash를 지정해 명시 적용한다. 해당 세션에 미종료 Run이 있으면 거절한다. 하나의 사본 lease 아래 모든 파일의 경로/hash/tree를 사전 확인한 뒤 기존 파일 broker를 사용한다. 적용 도중 외부 변경/새 Run/IO 실패가 생기면 남은 파일을 멈추고 파일별 applied/failed/uncertain을 보존한다. 여러 파일의 원자성이나 자동 rollback을 보장하지 않는다. 이미 적용/부분 적용한 요청을 다시 실행하지 않는다.
- 정상 다중 파일·BOM/CRLF/유니코드, 범위 밖 URI·잘못된 문서 버전·중복/겹침·stale, 취소·늦은 응답, 실패 뒤 부분 상태·재시작·중복 적용 및 실제 UI 명시 적용을 검증한다.
- 변경 제안의 질의 원본과 모든 대상은 고정 Git tree에 포함되고, 실제 읽은 bytes가 그 tree의 blob과 일치해야 한다. Git에서 제외된 파일이나 clean/EOL 필터 때문에 작업 사본과 snapshot bytes가 다른 파일은 안전한 원본 전제조건을 만들 수 없어 변경 제안을 거절한다. 읽기 전용 LSP 질의의 범위는 바꾸지 않는다. 적용 시에도 원본 문서와 대상 파일의 고정 기준을 다시 확인한다.
