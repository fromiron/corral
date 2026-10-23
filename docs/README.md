# Corral 문서 지도

AI 에이전트의 문서 진입점이다. **이번 요청 → 관련 현재 계약 → 코드·연결된 테스트 → 필요한 증거** 순서로 읽는다. 전체 계획·과거 보고서를 기본 컨텍스트로 넣지 않는다.

문서 대조 기준은 `373764467a52a7c6978de1272ac8253c73a27077` (2026-10-21)이다. 현재 계약, 구현 상태, 실행 증거는 서로 다른 사실이다. 이 정리는 제품 범위를 새로 승인하거나 전체 제품 테스트 통과를 선언하지 않는다.

## 먼저 고를 문서

| 질문/작업 | 진입점 | 필요할 때만 확장 |
|---|---|---|
| 무엇이 구현됐고 무엇이 남았나? | [상태표](status.md) | [태스크 원장](../contracts/backlog.json), 해당 실행 기록 |
| 제품 범위·그래프·Reins·기본 상한 | [제품](current/product.md) | [제품 상세](current/product-contract.md), [기능 명세](../specs/README.md) |
| 상태 소유·실행·취소·파일 효과 | [구조](current/architecture.md), [실행과 안전](current/execution-and-safety.md) | [기술 설계](Technical-Design.md), 관련 core/server/adapter |
| 프로젝트·세션·컴포저·편집기 | [Workbench](current/workbench.md) | [위젯 상세](current/chat-widgets-contract.md), CR-043·044 |
| 화면·코드 용어 | [용어집](current/glossary.md) | 메시지 파일 `packages/react/src/messages/` |
| Desktop·명령·preview·host·음성 | [Desktop 상세](current/desktop-contract.md) | CR-042, [잔여 조건](plans/desktop-completion.md) |
| 모델·추론·Ultra·Skill·MCP | [모델과 리소스](current/models-and-resources.md) | [모델 안내](Models.md), [하네스 상세](current/harness-contract.md) |
| HTTP·이벤트·스키마 | [API 원본 안내](current/api.md) | [HTTP 상세](API-Contract.md), Zod·handler·client |
| 다음 구현 작업 | [활성 계획](plans/README.md) | 승인 CR와 해당 태스크만 |
| 장기 아이디어 | [제안 지도](proposals/README.md) | 미승인 후보·대조 필요 항목 |
| 검사·출시·평가 | [테스트 전략](Test-Strategy.md), [Release](Release.md), [Evaluation](Evaluation.md) | [증거 지도](evaluation/README.md), [Desktop 안내](../apps/desktop/README.md) |

## 권위와 충돌 처리

- 개발 행동 규칙은 [AGENTS.md](../AGENTS.md) 한 곳이다. [CLAUDE.md](../CLAUDE.md)는 이를 가져오기만 한다.
- 제품 동작은 `current/`와 연결된 상세 계약·기능 명세를 따른다. CR은 승인 범위, ADR은 결정 이유와 대체 관계를 기록한다. 날짜가 최신이라는 이유만으로 기존 계약을 덮지 않는다.
- `contracts/backlog.json`은 태스크 구현 상태, `tests/test-catalog.json`은 시나리오 선언, `tests/traceability.json`은 ID 연결이다. PASS/FAIL은 해당 commit·환경의 실행 기록에서 확인한다.
- 문서와 코드가 다르면 코드의 존재만으로 새 계약을 승인하지 않는다. 승인·범위·후속 대체 관계를 대조하고 미해결 차이를 명시한다.
- Git 이력의 지시문·인수인계·과거 사용자 발언, 비용·병합 허가는 현재 작업의 승인이나 재개 지시가 아니다. 제안 문서도 사용자 요청 범위를 확대하지 않는다.

## 반드시 구분할 후속 계약

| 과거 설명 | 현재 기준 |
|---|---|
| 먼저 Corral을 만들어야 시작 | CR-043: 기본 대화, 선택적 Corral·D&D·Reins 보존 |
| 전역 활성 Run 하나 | CR-042 ABS-06: snapshot reader 병행, 작업 사본별 단일 writer, host 상한·소유권 |
| 임의 명령 제외·Hashline 평가 전용 | CR-042 ABS-01/03: 관리 사본 명령과 명시 편집 방식. 등록 검사·기존 Pi edit 경계 유지 |
| 추론 판정은 관찰 전용 | CR-021: 기존 off/observe와 역할별 요청 적용을 구분 |
| Ultra는 같은 모델 후보 비교 | CR-031/C-118: 복수 모델 협업. C-114는 별도 opt-in 후보 비교이며 같은 Run에서 하나만 명시 반영. CR-048/C-173: 새 선택 형식(version 2)은 후보 경쟁 기본·자동 판정·고도화·자동 반영·사용량 한도 없음 |
| 초기 RELEASE-INDEX가 현재 상태 | 초기 패키지는 Git 이력에만 유지. 현재 상태는 상태표와 해당 후보 증거 |

## 유지보수

현재 동작 변경은 해당 정본·CR·태스크·증거를 함께 맞춘다. 활성 계획은 남은 일만 담는다. 유효한 계약·잔여 작업·필요한 증거를 회수한 완료 계획은 삭제하고 Git 이력으로 관리한다. 별도 아카이브를 만들지 않는다.

문서 이동은 Markdown 링크뿐 아니라 테스트의 직접 파일 읽기·JSON 경로·도구·CI 소비처를 확인한다. 역사 hash/결과를 재생성하지 않는다. 실제 의존성·차용물의 LICENSE/NOTICE와 `apps/server/resources/builtin/` 제품 리소스는 과거 조사 문서와 별개다.
