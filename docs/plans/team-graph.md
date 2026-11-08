# 구현 계획: 팀 편집기와 팀 그래프 실행

작업용 문서다. 동작의 기준은 명세([팀 그래프 모델](../specs/features/team-graph.md), [팀 편집기](../specs/features/canvas.md))이고, 여기에는 순서와 진행 상황만 적는다. 계약을 여기에 옮겨 적지 않는다. 작업이 끝나면 이 문서를 지운다.

- 브랜치: `feat/team-editor-kit`
- 마지막 갱신: 2026-11-08

## 목표

루프·그래프 엔지니어링을 보고 고칠 수 있게 한다. 사람이 팀을 원하는 대로 짜는 편집기(React Flow 없이 디자인 키트로)와, 넓힌 그래프 모델을 실제로 실행하는 런타임이 함께 있어야 끝난다.

## 정해진 것

- 편집기: 구조 트리 + 캔버스 + 선택할 때만 뜨는 설정 시트 + ⌘K. 배치는 자동이고 저장하지 않는다.
- 패턴은 선택에 적용한다: 검토 루프로 감싸기, 확인 루프로 감싸기, Join으로 병렬 분기. 승인 단계 패턴은 없다.
- "지난 실행" 표시는 없다. 대신 **실행 통계**: 저장된 버전의 최근 실행을 모은 수치(루프 회차와 상한 도달, 판단 분기 비율, 에이전트 실패, 재시도, 비용 비중). 실시간 상태는 넣지 않고, 각 수치는 해당 실행으로 이어진다.
- 개발 중이므로 쓸모없어진 저장 데이터는 마이그레이션 없이 지운다.
- 확장 E2E는 구현이 끝난 뒤 한 번에 고친다. 그 전에는 smoke E2E만 유지한다.

## 진행 상황

| 단계 | 상태 | 커밋 |
|---|---|---|
| 1. 콘셉트 목업과 앱 안 프로토타입 | 완료 | f5dc1b2e |
| 2. 계약과 컴파일러 (넓힌 모델, 실행 못 하는 구성은 `RUNTIME_UNSUPPORTED`) | 완료 | 0e8f7268, c5bcc2e6, 97847332 |
| 편집기: 자동 배치, 구조 편집, 명령 메뉴 | 완료 | d54c08b1, c5b9e17e, 58ea5214 |
| 편집기: 명세, 패턴·참조 팀·전체 설정, 클래식 편집기 교체 | 완료 | d18391bc, b439e1a7, 88bea109 |
| 편집기: 저장 배치 삭제, `getRevision` | 완료 | 26529d19 |
| 실행 통계 레이어 | 완료 | e38660ec(명세), 4490f0bb |
| 3. 루프 실행 | 완료 | 22d72e0e, 915817de(명세), a5d550f7 |
| 4. 재시도, 실패 경로, router | 완료 | f4eaaabb(명세), 구현은 `feat: retry agents, take error paths and run routers`, 3cf75135(3단계 보완) |
| 4b. check Decision | 시작 전 | |
| 5. 병렬 | 시작 전 | |
| 6. 하위 팀 | 시작 전 | |
| 7. 위임 깊이 | 시작 전 | |
| 8. 포크와 중단점 | 시작 전 (명세 없음) | |
| 마무리: 확장 E2E, 명세 정리 | 시작 전 | |

런타임 단계(3–7)는 [실행 지원 범위](../specs/features/team-graph.md#실행-지원-범위)에서 해당 항목을 지우고, 컴파일러의 `RUNTIME_UNSUPPORTED` 규칙을 없애고, 실제로 실행하는 테스트가 통과하면 끝난다.

- 3: Loop 둘 이상, 상자 안의 상자, Loop `budget`·`stallDetection`·`exhausted`, `maxIterations` 상한, Loop로 시작.
- 4: Agent `retry`와 `error` 연결, `router` Decision과 `route` 승인.
- 4b: `check` Decision. 등록 검사의 주인이 지금은 실행(execution)이나 수동 세션뿐이라, Decision이 주인인 검사와 Run 시작에서 고정하는 프로젝트 검사 설정이 필요하다. 진짜 pass·fail이 아닌 결과(오류, 시간 초과, 취소, 바뀐 tree, 판정 불가)는 그 노드에서 사람을 기다린다.
- 5: 한 포트의 병렬 분기, Join.
- 6: Team 노드(안에 둔 팀, 저장된 팀 참조), Team으로 시작.
- 7: 2보다 큰 `maxDelegationDepth`, 설치 정책 상한을 넘는 `maxSpawns`.
- 8: 실행 옵션이다. 명세부터 쓴다.

## 다음 스텝

1. 4b단계(check Decision): 명세부터. Decision이 주인인 검사(`VerificationOwner`에 새 종류)와 Run 시작에서 고정하는 프로젝트 검사 설정, 진짜 pass·fail이 아닌 결과에서 사람을 기다리는 방법을 정한다.
2. 5단계(병렬과 Join).

## 남은 정리와 열린 질문

- 확장 E2E 13개가 옛 선택자를 쓴다(마무리 단계에서): `accessibility`, `editor-responsive`, `palette`, `performance/performance`, `studio`, `team-config`, `server/harness-recipe`, `server/markdown-agent-import`, `server/models`, `server/projects`, `server/reasoning-scope`, `server/server`, `server/team-config`.
- `/demo`에서 저장하면 수정이 사라진다. 데모 loader가 템플릿 id로 팀을 찾는데, 새 팀은 항상 새 id를 받아서 저장할 때마다 데모 팀을 다시 만든다. main에도 있던 문제다.
- `technical-design.md` 13.3절은 실행 화면 흐름 보기가 편집기 배치를 함께 쓴다고 하지만 `RunFlowView`는 쓰지 않는다. 어느 쪽이 맞는지 정해야 한다.
- `pnpm deps:check`는 Node ^24.15.0이 필요해 이 환경(24.14.0)에서 확인하지 못했다.
- Storybook `Timeline` > Ten Thousand Events가 실패한다. 선택한 이벤트 패널에 `#3885`를 기대하지만, 12faa4d1부터 패널이 기록 내용을 보인다. `AgentSteering` > Short Composer는 간헐적으로 대비 검사에 실패한다.
- 훅(도구 사용 전 동작, 추가 메시지)은 이 계획 밖이다.
- Loop 예산·정체로 멈춘 승인 카드 문구는 단위 테스트로만 확인했다. 실제 화면에서는 마무리 단계 E2E에서 본다.
- `route` 승인 카드는 단위 테스트와 Storybook `Run/ApprovalPanel` > Route Choice로 확인했다. 실제 서버의 router 실행은 마무리 단계 E2E에서 본다.

## 확인 방법

- 단위·통합: `pnpm lint`, `pnpm typecheck`, `pnpm test`. 계약이 바뀌면 `pnpm contracts:check`.
- 실제 서버에서 핫 리로드로 보기:
  - `node apps/server/src/main.ts --workspace . --allow-origin http://localhost:5173`
  - `CORRAL_SERVER=http://127.0.0.1:4317 pnpm --filter @corral/studio exec vite --port 5173`
  - 서버가 출력한 링크의 `#bootstrap=…`을 `http://localhost:5173/`에 붙여 연다.

## 갱신 규칙

단계를 끝낸 커밋에서 이 문서의 상태, 커밋, 다음 스텝을 함께 고친다.
