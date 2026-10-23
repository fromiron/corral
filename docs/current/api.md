---
kind: reference
status: current
baseline: 373764467a52a7c6978de1272ac8253c73a27077
---

# API와 계약 원본

HTTP·이벤트·오류의 상세 의미는 [API-Contract](../API-Contract.md)를 확인한다. 이 표는 전체 endpoint 자동 생성 목록이 아니므로 작업 범위의 서버 handler·클라이언트·계약 시험을 대조한다. 이 문서에 endpoint·필드 표를 별도 복제하지 않는다.

## 원본과 파생 자료

| 대상 | 확인 위치 |
|---|---|
| 도메인 타입·Zod 검증 | `packages/contracts` |
| 생성된 JSON Schema | `packages/contracts/generated/` |
| 요구·태스크 추적 원장과 초기 seed schema | `contracts/` (역할은 해당 README 참조) |
| HTTP·서비스 구현 | `apps/server` |
| 클라이언트 | `packages/client` |
| 생성·일치 검사 | `tools/contracts/generate.ts`, `pnpm contracts:check` |
| 요구·태스크·시험 연결 | `contracts/requirements.json`, `contracts/backlog.json`, `tests/test-catalog.json`, `tests/traceability.json` |

생성 schema와 사람이 작성한 설명을 독립된 스키마 원본으로 만들지 않는다. Pi 경계의 도구 parameter와 Corral 도메인 계약의 변환은 어댑터 경계 및 관련 시험에서 검증한다.

## 변경 시 보존할 의미

접수 receipt와 실제 적용·종료를 구분한다. 같은 command ID 재전송, 내용 충돌, revision 검사, snapshot과 SSE sequence, 늦은 이벤트의 소유권을 함께 확인한다. UI에서 완료를 추정해 도메인 기록을 만들지 않는다.

로컬 세션·workspace/host 범위·Host/Origin·CSRF 경계를 유지한다. credential을 응답·이벤트·오류에 반영하지 않는다. 참조 ID가 존재한다는 사실만으로 다른 Run·host·파일 scope 접근을 허용하지 않는다.

과거 snapshot/hash를 새 기본값으로 덮지 않는다. 새 필드는 optional 또는 명시한 schema version 등 승인된 호환 방식으로 추가하며, 과거 기록의 해석은 읽기 계층에서 구분한다.

## 디버깅·배포의 효과 경계

CR-046 P26/P27의 요청·응답 원본은 각각 `packages/contracts/src/debug.ts`와 `deployment.ts`, 등록 구성은 `project-tools.ts`다. 상세 경로는 [API-Contract](../API-Contract.md)를 따른다. 디버깅의 generation·정지 세대·command ID와 배포의 operation·환경·source identity를 구분하며, 상태 조회와 명시 실행을 같은 효과로 처리하지 않는다.

배포 명령의 종료 코드와 외부 결과 확인은 별개의 기록이다. 결과가 불확실하면 같은 receipt를 조회하고 재배포하지 않는다. 명시 중지로 소유 프로세스 정리와 예약 해제가 끝난 배포는 terminal이며, 외부 배포 결과가 미확인이라는 사실을 보존한다. 사용자 흐름과 지원 경계는 [Workbench](workbench.md#배포-작업과-결과-확인)에 둔다.

## 검사와 추적

계약 변경은 `pnpm contracts:check`, 추적·문서 변경은 `pnpm spec:check`와 관련 실제 시험을 실행한다. 생성 결과 일치, TC 태그 존재, schema 통과와 제품 동작 통과는 별개의 증거다.

문서 이동 때문에 CR·요구사항·태스크·테스트 ID를 재발급하지 않는다. 카탈로그의 `planned`는 시나리오 선언 형식으로 유지하며 실행 결과는 증거에 기록한다. 상세 소유권은 [실행과 안전](execution-and-safety.md)을 따른다.
