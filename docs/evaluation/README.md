# 검증 기록 읽기

이 디렉터리의 기록은 특정 후보·환경의 결과다. 제품 계약은 [현재 기준](../README.md), 반복 가능한 검사 절차는 [Test Strategy](../Test-Strategy.md), [Release](../Release.md), [Evaluation](../Evaluation.md)에서 확인한다.

## 기준선에서의 주요 기록

| 기록 | 읽을 때 구분할 것 |
|---|---|
| [Desktop 기능 진행](Desktop-Capabilities-Implementation-Progress.md) | 기능별 구현·Windows 검증·미검증 OS/외부 서비스, 서로 다른 빌드 회차 |
| [Chat-first 검토](Chat-First-UX-Review.md) | 기본 대화·선택적 Corral 변경, 해당 후보의 UI 경로 |
| [Desktop 배포 검증](../plans/Desktop-Delivery-Verification.md) | 검증한 runtime·산출물 identity와 미검증 배포 경계 |
| [성능](../Performance.md) | 장비·build hash·원본 sample·측정 범위 |

## 기록 원칙

검사 명령, commit/빌드 identity, OS·runtime, mock/live 구분, 성공·실패·skip, 미실행 조건과 원본 자산 위치를 보존한다. 보고서가 기록한 통과와 이번 작업에서 직접 재실행한 통과를 구분한다.

수정 뒤 일부 시험만 재실행했다면 이전 전체 실패를 전체 PASS로 바꾸지 않는다. 중복된 시험 묶음의 성공 수를 합산하지 않는다. ID 등록·schema 검사·모델 검토는 실제 제품 테스트를 대신하지 않는다.

모의 provider 성공은 외부 모델의 판단 품질·청구·마이크·SSH·업데이트 채널 성공 증거가 아니다. Windows 결과를 다른 OS로 일반화하지 않는다.

기존 `docs/plans/Desktop-*-Verification.md`, `docs/performance/`, `docs/validation/`는 경로 소비처를 확인하기 전 이동하지 않는다. 오래된 증거는 해당 시점의 기록으로 남기며 최신 상태에 맞춰 해시·결과를 재작성하지 않는다.
