# CR-042: Corral 데스크톱 기능 확장

- 상태: 구현 승인 — 2026-10-20, 사용자가 구현 계획을 검토한 대화에서 “구현해”라고 요청.
- 기준: `ad0bb6d`; [구현 계획](../plans/Desktop-Capabilities-Implementation-Plan.md)의 ABS-01–15, I00–I17.
- 구현·검증 완료는 기능별 증거로 별도 기록한다. 이 CR은 완료 선언이 아니다.

## 확장 계약

기존 단일 활성 Run, 등록 검사만 허용한 명령 실행, 평가 전용 Hashline 범위를 확장한다.
Coordinator의 상태 확정, effect intent/승인/예산, 불변 산출물, Reins와 D&D 계약은 유지한다.
셸은 실제 관리 사본에서 실행하고 등록 검사의 고정 snapshot 실행과 구별한다.
권한 프리셋은 기존 deny/strict/review-only를 확대하지 않는다.
Hashline은 기존 Pi edit를 깨지 않는 버전 있는 추가 방식이다.
다중 Run은 worktree별 writer와 host 전체 자원 상한 및 세션별 UI 소유를 포함한다.
새 기능이 미지원 환경에서 기존 경계를 몰래 해제하는 fallback은 금지한다.

프로세스는 host/session/run/execution/attempt/effect 소유를 기록하고,
취소 요청과 자식 종료 확인을 구분한다. 재시작 시 효과를 자동 replay하지 않는다.
모든 import/미리보기/외부 provider/원격 host는 계획에 정의한 신뢰·revision 경계를 따른다.
유료 모델·공개 배포·외부 업로드는 검증을 위해 자동 수행하지 않는다.

## 변경과 검증

정상/거절/취소/중복/늦은 결과를 기존 제품 입구에서 검증한다.
`TC-ABS-01`부터 `TC-ABS-15`까지 각 기능의 H/N 시나리오를 사용한다.
구현하지 않은 단계는 planned로 남기고 테스트 또는 UI만 만든 것을 기능 완료로 기록하지 않는다.
기존 Run/정의에 필드가 없으면 기존 의미와 hash를 유지한다.

### ABS-11 부모 질문 경로

Markdown import의 delegate link에는 명시적인 `parentQuestions: true` 권한을 저장한다.
미지정 link와 일반 question link는 계속 새 callable 응답 작업을 만든다.
새 권한은 자식의 `ask`와 부모의 `reply`를 요구하며, import 미리보기에서 부모에게
추가할 협업 권한을 함께 확인한다. 부모보다 넓은 작업 도구나 사용자 질문·Run 제어 권한은
자식에게 부여하지 않는다.

이 경로의 질문은 자식을 위임한 기존 부모 execution과 현재 attempt에 고정한다.
새 Task·responder·spawn/depth 예약을 만들지 않으며 기존 질문 수·시간·모델 예산은 적용한다.
부모의 `await_tasks` 또는 순차 items 대기는 미답변 질문이 생기면 현재 작업 상태와 질문을
반환하고, 같은 부모가 `reply(questionId, body)`한 뒤 대기를 이어간다. 부모가 다른 일을
수행 중이면 다음 모델 요청 경계에 별도 agent-message inbox를 전달한다. 사람의 directive로
취급하지 않는다. 순차 items는 같은 batch를 이어 실행하고 앞 항목 성공 전 다음 항목을
시작하지 않는다.

부모 답변은 부모 Task를 완료하지 않으며 자식은 같은 execution에서 답변을 받고 계속한다.
질문 timeout·자식 취소는 부모를 취소하지 않는다. 부모 취소는 기존 자식 취소 전파를 따른다.
scope 밖·과거 attempt·중복·종결 뒤 답변은 새 작업이나 현재 시도의 답변이 될 수 없다.
TC-ABS-011의 compiler/import RED, 실제 Pi 질문 왕복, items 순서, 질문 동시 도착,
timeout·취소·재시작 및 기존 manual-team 질문 회귀로 검증한다.

## 구현 기록

- 착수: `feat/desktop-capabilities`. 기능별 테스트 결과와 환경 한계는 후속 증거 문서에 기록한다.
- ABS-06 프로세스 admission은 호스트의 **소유 프로세스 그룹 12개**를 기본 상한으로 삼는다.
  명령·등록 검사·LSP·clone·미리보기 브라우저·SDK worker·stdio MCP가 같은 예약을 사용한다.
  SDK 내부 MCP는 별도 카운터를 만들지 않고 부모 호스트의 IPC 허가를 받는다.
  허가 토큰은 발급받은 worker 인스턴스에 귀속되며 다른 worker가 반환할 수 없다.
  용량이 가득 차면 새 그룹을 띄우기 전에 명시적으로 거절한다.
  시작 중인 그룹과 종료 확인이 불확실한 그룹도 상한에 포함하고, OS 그룹 종료 확인 후 반환한다.
  SDK가 확인된 자식 종료 허가 반환을 보내기 전에 종료되면 남은 자식 예약은 불확실한 상태로 유지한다.
  SDK 종료나 IPC 단절만으로 예약을 반환하지 않으며, 이 경우 현재 서버의 가용 용량이 줄어들 수 있다.
  서버 재시작은 기존 SDK lease 복구를 먼저 수행한 뒤 새 작업을 허용한다. 불확실한 예약의 자동 복구를 주장하지 않는다.
  이는 임의 셸이 생성하는 모든 자식 PID의 개수 제한을 의미하지 않는다.
  Windows에서는 Job이 명령·MCP·브라우저의 후손 수명을 소유하며, SDK의 IPC와 별도 MCP 그룹 허가는 유지한다.
  모델 요청·resident worker의 Coordinator 제한은 별도로 적용한다.
