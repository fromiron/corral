---
kind: reference
status: current
baseline: a9bb0bb93411cd89a24e27d8b237b53d3e9cf813
---

# API와 계약 원본

HTTP·이벤트·오류의 상세 의미는 [API-Contract](../API-Contract.md)를 확인한다. 초기 제안 표, 구현 추가 표, 후속 CR이 함께 있으므로 작업 범위의 서버 handler·클라이언트·계약 시험을 대조한다. 이 문서에 endpoint·필드 표를 별도 복제하지 않는다.

## 원본과 파생 자료

| 대상 | 확인 위치 |
|---|---|
| 도메인 타입·Zod 검증 | `packages/contracts` |
| 생성된 JSON Schema와 추적 원장 | `contracts/` |
| HTTP·서비스 구현 | `apps/server` |
| 클라이언트 | `packages/client` |
| 생성·일치 검사 | `tools/contracts/generate.ts`, `pnpm contracts:check` |
| 요구·태스크·시험 연결 | `contracts/requirements.json`, `contracts/backlog.json`, `tests/test-catalog.json`, `tests/traceability.json` |

생성 schema와 사람이 작성한 설명을 독립된 스키마 원본으로 만들지 않는다. Pi 경계의 도구 parameter와 Corral 도메인 계약의 변환은 어댑터 경계 및 관련 시험에서 검증한다.

## 변경 시 보존할 의미

접수 receipt와 실제 적용·종료를 구분한다. 같은 command ID 재전송, 내용 충돌, revision 검사, snapshot과 SSE sequence, 늦은 이벤트의 소유권을 함께 확인한다. UI에서 완료를 추정해 도메인 기록을 만들지 않는다.

로컬 세션·workspace/host 범위·Host/Origin·CSRF 경계를 유지한다. credential을 응답·이벤트·오류에 반영하지 않는다. 참조 ID가 존재한다는 사실만으로 다른 Run·host·파일 scope 접근을 허용하지 않는다.

과거 snapshot/hash를 새 기본값으로 덮지 않는다. 새 필드는 optional 또는 명시한 schema version 등 승인된 호환 방식으로 추가하며, 과거 기록의 해석은 읽기 계층에서 구분한다.

## 검사와 추적

계약 변경은 `pnpm contracts:check`, 추적·문서 변경은 `pnpm spec:check`와 관련 실제 시험을 실행한다. 생성 결과 일치, TC 태그 존재, schema 통과와 제품 동작 통과는 별개의 증거다.

문서 이동 때문에 CR·요구사항·태스크·테스트 ID를 재발급하지 않는다. 카탈로그의 `planned`를 실행 보고서 없이 `passed`로 바꾸지 않는다. 상세 소유권은 [실행과 안전](execution-and-safety.md)을 따른다.
