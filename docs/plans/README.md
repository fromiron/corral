# 계획 지도

계획은 남은 변경을 설명하며 현재 제품 계약이나 실행 증거가 아니다. [현재 기준 지도](../README.md)에서 주제를 고른 뒤 해당 계획의 필요한 절만 읽는다.

## 기존 계획의 해석

이 디렉터리는 과거 구현 단계, 인수인계, 검증 보고서가 혼재한 상태에서 이관 중이다. 파일이 이 디렉터리에 있다는 이유만으로 활성 작업이나 완료로 판정하지 않는다. 아래는 기준선 `a9bb0bb`에서 확인해야 할 출처와 주의사항이며 모든 태스크를 전수 재검증한 상태표가 아니다.

| 출처 | 사용 범위 | 주의사항 |
|---|---|---|
| [통합 개선 계획](Corral-Improvement-Execution-Plan-2026-10-19.md) | 남은 M4 항목과 기존 단계의 연결 | M0~M3 기록을 현재 후보의 전체 통과로 해석하지 않음. 전역 Run 하나 제약은 CR-042 범위와 대조 |
| [Desktop 기능 계획](Desktop-Capabilities-Implementation-Plan.md) | ABS별 완료 조건·남은 구현/환경 검증 | [진행 기록](../evaluation/Desktop-Capabilities-Implementation-Progress.md)과 함께 확인. 승인만으로 모든 OS 완료 처리 금지 |
| [Desktop 배포 검증](Desktop-Delivery-Verification.md) 및 `Desktop-*-Verification.md` | 특정 후보의 검증 절차·결과 | 일반 구현 계획이 아니라 증거/절차 자료. 과거 해시·실패·미검증 조건 보존 |
| [Personal Harness 구현 계획](Personal-Harness-Implementation-Plan.md), [인수인계](Personal-Harness-Handoff.md) | 미이관 상세와 기존 작업 연결 | 최신 CR·코드·증거와 태스크별 대조 후 남은 작업만 이관 |
| [UI 구조](UI-Structure-Plan.md), [채팅 위젯](Corral-Chat-Widgets-Implementation-Plan-v2.md) | 해당 변경의 배경·수용 기준 | 현재 기본 진입점은 CR-043, 과거 UI 순서를 기본 UX로 복원하지 않음 |
| [v0.2 보충 계획](Corral-Implementation-Plan-v0.2-Supplement.md), [로드맵](Roadmap-v0.2-Execution.md) | 이전 단계 추적 | 현재 제품 상태나 활성 전체 roadmap으로 사용하지 않음 |
| `Workbench-*`, `Resource-Management-Plan.md`, `Reasoning-Implementation-Plan.md` | 범위별 태스크 추적 | 파일명·체크박스만으로 완료 판정하지 않음 |

## 남은 작업을 등록하는 형식

새 활성 계획은 승인 근거, 기준 commit, 적용 범위, 관련 정본, 남은 태스크, 완료 조건을 명시한다. 같은 범위의 여러 계획이 서로 다른 제품 계약을 갖지 않게 한다. 새로운 계획이 생겼다고 기존의 미완료 태스크를 유실시키지 않는다.

```yaml
---
kind: plan
status: active
scope: concrete-change
baseline: full-commit-sha
change_requests:
  - existing-approved-cr-id
canonical_docs:
  - docs/current/relevant-topic.md
---
```

이 예시는 상태 형식만 설명한다. 승인되지 않은 제안은 `status: proposed`로 두며 이번 정리에서 임의의 CR 번호를 만들지 않는다. 완료·대체 시에는 후속 정본과 증거를 연결하고 활성 목록에서 제거한다.

## 정리 후속 범위

기존 태스크별 승인·구현·증거 대조, 검증 보고서의 물리적 이관, 중복 합본·참고 조사 삭제는 별도 소비처 확인이 필요한 잔여 작업이다. 이 첫 정리에서 완료했다고 표시하지 않는다. 원본·미완료 작업·추적 ID를 보존하며 [보관 정책](../archive/README.md)을 따른다.
