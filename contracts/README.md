# contracts

| 경로 | 역할 |
|---|---|
| `*.schema.json` | 초기 seed JSON Schema |
| `event-catalog.json` | 초기 이벤트 설계 목록. 현재 payload union 전체를 대신하지 않음 |

현재 도메인 타입과 검증의 원본은 [packages/contracts/src](../packages/contracts/src/)이고, 생성 JSON Schema는 [packages/contracts/generated](../packages/contracts/generated/)다. `pnpm contracts:check`가 생성 결과 일치를 확인한다. 이 디렉터리의 seed schema는 손으로 맞추지 않는다. 제품 계약 문서는 [docs/specs](../docs/specs/README.md)에 있다.
