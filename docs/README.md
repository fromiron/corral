# Corral 문서 지도

이 문서는 개발 문서의 진입점이다. 필요한 주제만 읽고 관련 코드·계약·테스트를 확인한다. 전체 과거 계획을 선행 컨텍스트로 읽지 않는다.

기준선: `a9bb0bb93411cd89a24e27d8b237b53d3e9cf813` (2026-10-21, PR #65). 현재 기준 문서는 해당 기준선의 승인 계약을 정리한 **탐색용 요약**이며 제품 테스트 통과 선언이 아니다. 상세 규칙은 연결된 계약의 해당 절에서 확인한다. 이번 정리로 승인 범위나 런타임 동작을 바꾸지 않는다.

## 작업별 읽기 경로

| 작업 | 먼저 읽기 | 필요할 때만 확장 |
|---|---|---|
| 제품 범위·사용 흐름 | [제품](current/product.md) | 해당 기능 CR·증거 |
| 패키지·상태 소유권 | [구조](current/architecture.md) | 관련 패키지와 기술 설계 해당 절 |
| 실행·취소·권한·파일 효과 | [실행과 안전](current/execution-and-safety.md) | core·server·adapter 및 관련 테스트 |
| 프로젝트·세션·컴포저·편집기 | [Workbench](current/workbench.md) | 해당 CR·화면·회귀 테스트 |
| 모델·추론·Ultra·내장팩 | [모델과 리소스](current/models-and-resources.md) | 모델 안내·adapter·리소스 owner |
| HTTP·이벤트·스키마 | [API](current/api.md) | 상세 API 문서·Zod·생성 계약 |
| 검사·배포·평가 | [테스트 전략](Test-Strategy.md), [Release](Release.md), [Evaluation](Evaluation.md) | [증거 안내](evaluation/README.md), [Desktop](../apps/desktop/README.md) |
| 남은 구현 작업 | [계획 지도](plans/README.md) | 승인된 해당 CR과 필요한 계획 절 |

공통 개발 규칙은 [AGENTS.md](../AGENTS.md) 한 곳에서 관리한다. [CLAUDE.md](../CLAUDE.md)의 내용은 `@AGENTS.md` 한 줄로 유지한다. 새로운 공통 규칙을 Claude 전용 파일에 넣지 않는다.

## 문서의 역할

| 종류 | 의미 | 의미하지 않는 것 |
|---|---|---|
| 현재 기준·상세 계약 | 승인된 동작과 제약, 알려진 차이 | 모든 환경에서 구현·검증 완료 |
| CR·ADR | 승인 범위와 설계 결정·대체 관계 | 코드의 존재·테스트 통과 |
| 계획 | 이번 변경에서 남은 작업·완료 조건 | 현재 제품 기능이나 새로운 승인 |
| 검증 증거 | 특정 후보·환경에서 실행한 검사 | 다른 commit·OS·provider에서의 성공 |
| 역사·참고 조사 | 당시의 가정·대안·판단 | 현재 작업 지시 |

승인됨, 구현됨, 검증됨을 하나의 `done`으로 합치지 않는다. 코드·스키마는 실제 구현의 근거지만, 계약과 다른 코드를 곧바로 새 계약으로 승인하지 않는다. 문서 충돌은 범위·승인·대체 관계로 해소하고 미해결 항목은 명시한다.

## 기준선에서 주의할 대체 관계

| 오래된 설명 | 현재 확인할 계약 |
|---|---|
| 먼저 Corral을 만들어야 시작한다 | [CR-043](change-requests/CR-043-chat-first-optional-corral.md): 기본 대화와 선택적 Corral |
| 전역 활성 Run은 언제나 하나다 | [CR-042](change-requests/CR-042-desktop-capabilities.md) ABS-06: snapshot reader 병행·작업 사본별 단일 writer, host 상한과 개별 소유권 |
| 임의 명령은 일괄 제외한다 | CR-042 ABS-01: 관리 사본의 승인·effect·process lease 계약. 등록된 검증 명령과 구분 |
| Hashline은 평가 전용이다 | CR-042 ABS-03: 명시 선택한 제품 편집 방식. 기존 Pi edit를 대체하지 않음 |
| Electron은 사용하지 않는다 | [Desktop 패키지](../apps/desktop/package.json)와 [안내](../apps/desktop/README.md). OS별 검증 상태는 별도 |
| Ultra는 같은 모델의 후보 비교뿐이다 | [모델 안내](Models.md)의 복수 모델 Ultra 계약. 비용·권한 상한 자동 증가는 아님 |
| 추론 판정은 언제나 관찰 전용이다 | [CR-021](change-requests/CR-021-role-reasoning-apply.md)과 현재 모델 계약에서 관찰·적용 범위를 구분 |
| RELEASE-INDEX는 현재 제품 상태다 | [초기 팩 인덱스](../RELEASE-INDEX.json)는 2026-10-14 문서 팩 기록. 현재 후보는 Release 절차와 해당 증거로 판정 |

## 유지보수 규칙

현재 동작 변경 PR은 해당 현재 기준 문서와 상세 계약을 함께 갱신한다. 계획은 계약을 복제하지 말고 관련 문서와 CR을 링크한다. 완료 계획에서 여전히 유효한 계약과 남은 작업을 회수한 후에 보관·삭제한다.

기존 CR·ADR·요구사항·태스크·테스트 ID는 보존한다. 문서 이동은 링크뿐 아니라 `tools/`, CI, traceability, manifest의 소비처를 확인한 뒤 한다. 과거 검사 결과·hash를 새 내용에 맞춰 덮어쓰지 않는다.

외부 제품 비교·선정 조사는 기본 읽기 경로에서 제외한다. 실제 라이브러리·Skill·코드 차용의 라이선스와 고지는 별도로 유지한다. [과거 자료 안내](archive/README.md)는 이력 조사가 필요할 때만 읽는다.
