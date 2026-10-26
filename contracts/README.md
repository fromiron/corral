# 계약·태스크 원장

| 경로 | 역할 | 상태 해석 |
|---|---|---|
| `requirements.json` | 제품 요구 ID의 원장 | 요구 등록은 구현 완료가 아님 |
| `backlog.json` | 태스크·의존성·완료 조건·구현 상태·증거 연결 | planned / in_progress / implemented / removed. `removed`는 기능이 제거된 태스크이며 `removedBy`가 제거 태스크를 가리킨다. 환경별 실행 결과와 구분 |
| `*.schema.json` | 초기 문서팩의 seed schema·예제 검사 입력 | 현재 runtime DTO나 생성 스키마의 정본이 아님 |
| `event-catalog.json` | 초기 이벤트 설계 목록 | 현재 payload union 전체를 대신하지 않음 |

현재 도메인 타입과 검증의 원본은 [packages/contracts/src](../packages/contracts/src/), 생성 JSON Schema는 [packages/contracts/generated](../packages/contracts/generated/)다. `pnpm contracts:check`가 생성 결과 일치를 확인한다. 이 디렉터리의 seed schema와 별도로 손으로 맞추지 않는다.

[테스트 카탈로그](../tests/test-catalog.json)의 `planned`와 `evidence: null`은 시나리오 선언 형식이다. 구현/실행 결과를 뜻하지 않으며, 모든 제품 테스트가 미구현이라는 의미도 아니다. [traceability](../tests/traceability.json)는 요구→태스크→TC 연결이다. 실행 PASS/FAIL과 mock/live·OS·commit은 [증거](../docs/evaluation/README.md)에 기록한다.

`pnpm spec:check`는 ID·의존 순환·schema/예제·문서 링크·TC 태그를 검사한다. 제품 compiler·권한·취소·E2E 통과를 대신하지 않는다. 현재 구현과 남은 일은 [상태표](../docs/status.md)에서 고른다.
