---
kind: contract
status: current
baseline: 373764467a52a7c6978de1272ac8253c73a27077
---

# 개인 하네스 상세 계약

승인 근거는 [CR-018](../change-requests/CR-018-pi-standard-harness.md), [CR-019](../change-requests/CR-019-harness-verification.md), [CR-020](../change-requests/CR-020-harness-composition.md)다. H2–H8/C-077–083은 구현돼 있으며 [당시 검증](../evaluation/Personal-Harness-Validation-2026-10-18.md)의 환경 한계를 유지한다. 단계명은 추적 식별자이며 구현 재개 지시가 아니다.

구체적인 DTO·IPC는 `packages/contracts/src/harness.ts`와 `packages/adapter-pi/src/protocol.ts`의 현재 정의를 따른다. 과거 계획의 SDK 호출 예시를 현재 라이브러리 API로 복사하지 않는다.

## H2 실행·권한·기록

- SDK는 실행 소유 worker에서 구동한다. 서버 프로세스가 native 확장을 직접 로드하지 않는다. 기존 core worker와 SDK worker의 호환 경로를 보존한다.
- turn·압축·재시도·확장 중첩 모델 호출은 Corral permit과 같은 Run 예산을 사용한다. 자격 증명 없는 proxy와 host의 요청별 허가 경계를 우회하지 않는다.
- 도구는 최종 인자·descriptor·현재 정책으로 승인한다. Corral broker를 거치지 않는 Pi 기본 도구로 교체하지 않는다. 승인 뒤 변경·예외·unknown 효과는 fail closed다.
- 역할 allowlist·resource revision·directive·요청 context를 고정하고 실제 payload의 hash·크기를 기록한다. 공개 이벤트에 본문·키·내부 경로를 노출하지 않는다.
- 필수 확장 로드 실패는 다른 runtime으로 조용히 fallback하지 않는다. 취소는 소유 worker·MCP·codemode의 실제 종료와 늦은 이벤트를 구분한다. Task/Run 완료는 Coordinator가 확정한다.
- `sdk-worker.ts`, `worker.ts`, `worker-tools.ts`, `worker-leases.ts`가 구현 입구다. SDK 세션의 settled가 곧 제품 성공은 아니다.

## H3 리소스·역할·UI

- 발견 → 설치 검토 → 설치 → hash별 신뢰 → 바인딩 → 실행은 별개다. 발견·미리보기는 확장 코드를 실행하지 않는다.
- 실행 자산과 `HarnessProfileRevision`은 불변이다. 내용 변경은 신뢰 재검토 대상이며 실행 중 snapshot을 바꾸지 않는다. reload로 현재 Run 자산을 교체하지 않는다.
- 개인 → 프로젝트 → 역할 → 실행의 scope를 구분하고, 하위 설정이 필수 정책·허용 도구 제한을 확대하지 못한다. 설정 기본값의 저장·적용은 [CR-040](../change-requests/CR-040-settings-scope-and-saving.md)을 따른다.
- 정적 미리보기와 실제 Run은 같은 해석 경로를 사용한다. 설치·선택·읽기·payload 전달·실제 수행은 다른 상태다.
- 사용자 홈 설정은 명시적 복사 import만 허용한다. 실행용 HOME/XDG 분리는 설정 충돌을 줄이는 장치이며 OS 보안 격리 자체가 아니다. `strict` 역할에 trusted-native 확장을 우회 결합하지 않는다.
- 확장 UI 질문은 원래 실행·요청 ID·timeout을 가지며 stale/중복 답변·종결 뒤 응답을 거절한다.
- 구현 입구는 `apps/server/src/harness/`, Studio `workbench/harness/`, storage의 revision·binding이다. 관리 생명주기는 [CR-022](../change-requests/CR-022-resource-management.md)가 보완한다.

## H4 코딩 도구와 LSP

- Pi read/edit/write의 사용자 계약을 Corral broker에 연결한다. execution별 읽기 근거·원본 hash·직렬화·원자 쓰기·불변 diff를 유지한다.
- BOM/CRLF/Unicode·부분 읽기·원본 변경/삭제·scope 밖 경로·취소를 처리한다. 모델 인자로 OS 임의 경로를 허용하지 않는다.
- LSP 조회와 text-edit 제안·사용자 적용은 별개다. 임의 command·파일 생성/삭제/rename resource operation은 지원하지 않는다. 기존 UTF-8 파일의 선언적 edit만 취급한다.
- 다중 파일 적용은 파일별 결과를 보존한다. stale/부분 실패를 전체 성공으로 표시하거나 자동 rollback/replay하지 않는다. Git tree와 bytes 일치 및 적용 직전 재검증을 유지한다.
- Hashline의 초기 평가 전용 경계는 [CR-042 ABS-03](../change-requests/CR-042-desktop-capabilities.md)이 제품 선택 방식으로 확장했다. 기존 Pi edit를 자동 대체하지 않는다.

## H5 등록 검사

- 관리 사본의 고정 tree를 별도 검증 사본에서 등록 argv로 실행한다. 일반 명령/service(ABS-01)와 같은 기능으로 합치지 않는다.
- tree·명령·설정·실행 fingerprint에 승인과 보고서를 묶는다. 취소·stale·실패·unknown을 pass로 바꾸지 않는다. 출력 크기·시간·프로세스 소유권과 정리를 검증한다.
- 보고서의 실행 상태와 품질 판정은 다르다. schema 통과만으로 실제 검사 성공을 인정하지 않는다.

## H6 검토·제한된 개선·평가

- 기준 파일/hash와 산출물 버전을 고정하고 모델이 바꾼 기준으로 자기 결과를 승인하지 못하게 한다. 실제 검사 실패가 모델의 긍정적 검토보다 우선한다.
- 수정 횟수·시간·호출·토큰 상한, 같은 실패/출력 반복·무진전·예산 소진 중단과 이유를 유지한다.
- `personal_harness`의 다섯 비교군과 calibration/holdout을 보존한다. fixture 성공은 실제 모델 품질 향상 증거가 아니다. [Evaluation](../Evaluation.md)을 따른다.

## H7–H8 반복·MCP·codemode

- 항목별 입력을 분리하고 앞 항목 성공 전 다음 항목을 시작하지 않는다. 부모 예산·취소·깊이·소환 상한과 같은 사본의 writer 소유권을 유지한다.
- MCP는 등록 서버·정확한 도구 allowlist·인증 binding을 사용한다. stdio 프로세스, HTTP/OAuth, probe 및 실제 실행의 수명과 취소 소유권을 구분한다.
- codemode의 중첩 도구도 같은 승인 경로를 사용한다. 별도 무제한 실행 엔진을 만들지 않는다. worker 상한과 host 공통 process admission을 모두 적용한다.
- 새 부모 질문 경로와 process 그룹 상한은 CR-042가 보완한다. native 확장·원격 MCP의 신뢰는 코드 불변성이나 sandbox 보장이 아니다.

## 추적과 검증

CRL-HAR-001–008은 요청·도구·기록·리소스·전달·필수 확장·UI·strict 경계를, CRL-HAR-010–014는 편집·읽기 근거·검사·보고서·제한 개선을 추적한다. 실제 연결은 [원장](../../contracts/backlog.json), [TC 카탈로그](../../tests/test-catalog.json), [traceability](../../tests/traceability.json)를 따른다. ID를 재발급하지 않는다.

기존 `core/test/harness`, `review-recipe`, `items`, adapter의 SDK/MCP·리소스, server의 harness/LSP/검사 회귀에서 변경 범위의 반례를 고른다. 새 실행 결과는 현재 후보·OS·mock/live를 기록하며 과거 보고서의 수치를 덮어쓰지 않는다.
