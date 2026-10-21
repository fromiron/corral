# 검증 기록 지도

이 디렉터리는 특정 commit·빌드·환경에서의 결과를 보존한다. 현재 제품 계약은 [문서 지도](../README.md), 구현과 남은 일은 [상태표](../status.md), 반복 가능한 절차는 [Test Strategy](../Test-Strategy.md)·[Release](../Release.md)·[Evaluation](../Evaluation.md)에서 확인한다.

| 범위 | 증거 |
|---|---|
| Desktop 기능·플랫폼 한계 | [전체 진행](Desktop-Capabilities-Implementation-Progress.md), [배포](Desktop-Delivery-Verification.md), [preview](Desktop-Preview-Verification.md), [동시 실행](Desktop-Concurrency-Verification.md), 나머지 Desktop 기능별 보고서 |
| 문맥형 설정·Composer | [CR-044 구현·Linux 검증](Contextual-Settings-UI-2026-10-21.md) |
| Workbench 식별·테두리 일관성 | [CR-045 구현·Linux 검증](Workbench-Identification-2026-10-21.md) |
| 기본 대화·Workbench | [기본 대화](Chat-First-UX-Review.md), [초기 Desktop](Desktop-Workbench.md), [UX 대조](UX-Spec-Conformance.md) |
| 하네스·추론·리소스 | [H2–H8](Personal-Harness-Validation-2026-10-18.md), [추론](Reasoning-Controls-2026-10-18.md), [리소스](Resource-Management-2026-10-18.md) |
| 통합 개선 | [M0](Integrated-Improvement-M0-2026-10-19.md), [M1](Integrated-Improvement-M1-2026-10-19.md), [M2](Integrated-Improvement-M2-2026-10-19.md), [M3](Integrated-Improvement-M3-2026-10-19.md), [M4](Integrated-Improvement-M4-2026-10-19.md) |
| 문서 상태 대조 | [2026-10-21 정리](Documentation-Reconciliation-2026-10-21.md) |
| 성능·초기 실행 | [성능 절차와 측정](../Performance.md), [원시 성능 자산](../performance/), [P0–P9](../../specs/001-canvas/evidence/) |

## 기록 원칙

명령, commit/빌드 identity, OS·runtime, mock/live, 성공·실패·skip, 미실행 조건과 원시 자산 위치를 보존한다. 보고서의 과거 성공과 이번 후보에서 재실행한 성공을 구분한다. 일부분 재검증으로 이전 전체 실패를 전체 PASS로 바꾸거나 중복 시험 수를 합산하지 않는다.

fixture·schema·TC 태그·모델 검토는 실제 외부 모델·마이크·SSH·업데이트 성공을 대신하지 않는다. Windows 결과를 다른 OS로 일반화하지 않는다. 과거 보고서의 “현재”, “다음 작업”, 당시 브랜치는 그 보고서 기준선에만 적용한다.

기존 `docs/plans/*Verification.md`와 추론 검증은 이곳으로 옮겼다. raw 성능 JSON과 `tests/pack-validation-report.json`은 원래 hash·결과를 유지한다. 초기 manifest·패키지 사본은 Git 이력으로만 관리한다. `pnpm spec:check`의 새 결과는 임시 경로에 생성되며 저장된 역사 JSON이 현재 통과 증거가 아니다.
