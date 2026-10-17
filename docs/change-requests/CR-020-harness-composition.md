# CR-020: 항목 반복·MCP·codemode·LSP 변경 제안 (R3)

- 상태: 채택·구현 중, 2026-10-18. Bell의 H2–H8 구현 계속 요청.
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
