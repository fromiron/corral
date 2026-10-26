# Corral 명세

Corral은 명세 우선(spec-driven)으로 개발한다. **이 디렉터리가 제품의 단일 정본이다.** 동작을 바꾸려면 먼저 해당 명세를 고치고, 그 명세의 수용 기준을 실패하는 테스트로 만든 뒤 구현한다. 명세와 코드가 다르면 어느 쪽이 맞는지 사용자에게 확인한다. 명세에 맞추려고 테스트를 약화하거나 삭제하지 않는다.

모든 파일을 기본 컨텍스트로 읽지 않는다. 아래 표에서 이번 작업과 관련된 문서만 고른다.

## 어디를 읽을까

| 작업 | 문서 |
|---|---|
| 제품 범위·기본 흐름·비협상 항목 | [product.md](product.md), [constitution.md](constitution.md) |
| 제품·그래프·Reins·예산·보안 상세 | [product-contract.md](product-contract.md) |
| 상태 소유·실행·취소·파일 효과 | [architecture.md](architecture.md), [execution-and-safety.md](execution-and-safety.md), [technical-design.md](technical-design.md) |
| 프로젝트·세션·컴포저·편집기·Git·터미널 | [workbench.md](workbench.md) |
| 채팅 위젯·현황 카드·Todo | [chat-widgets-contract.md](chat-widgets-contract.md) |
| Desktop·명령·preview·host·음성 | [desktop-contract.md](desktop-contract.md) |
| 개인 하네스·Skill·MCP·확장 | [harness-contract.md](harness-contract.md) |
| 모델·추론·리소스 | [models-and-resources.md](models-and-resources.md) |
| 관리형 LLM 요청·컨텍스트·캐시·정산 | [llm-runtime.md](llm-runtime.md) |
| HTTP·이벤트·스키마 | [api.md](api.md), [api-contract.md](api-contract.md) |
| 화면·코드 용어 | [glossary.md](glossary.md) |
| 기능별 수용 기준 | [features/](features/): [canvas](features/canvas.md), [reins](features/reins.md), [demo-release](features/demo-release.md), [시나리오 원문](features/mvp.feature) |
| 디자인 토큰·공용 컴포넌트 | [DESIGN.md](../../DESIGN.md) |
| 모델 연결·출시·평가 사용법 | [guides/](../guides/) |

## 작업 순서

1. 관련 명세를 읽는다. 없으면 [features/_template.md](features/_template.md)로 기능 명세를 먼저 쓴다.
2. 명세를 바꾼다. 사용자가 확정한 목표가 바뀐 경우가 아니면 비협상 항목([constitution.md](constitution.md))을 약화하지 않는다.
3. 새 동작과 데이터·권한·취소 경계의 대표 반례를 테스트로 쓰고 실패를 확인한다.
4. 최소 구현으로 통과시킨다. 관련 lint·typecheck·테스트를 실행한다.
5. 계약 타입을 바꿨다면 `pnpm contracts:check`를 실행한다.

## 명세 작성 원칙

- 명세는 **현재 동작**만 쓴다. 변경 이력, 승인 과정, 구현 일정, 검증 기록은 쓰지 않는다. 이력은 Git이 가진다.
- 계약은 한 곳에만 쓴다. 다른 문서는 링크한다.
- 접수·적용·전달·종료처럼 서로 다른 사실은 다른 이름으로 쓴다. 구현하지 않은 것은 구현했다고 쓰지 않는다.
- 코드가 정본인 부분(타입, 생성 스키마, 메시지 문구)은 위치만 적는다.
