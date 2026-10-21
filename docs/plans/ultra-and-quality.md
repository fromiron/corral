---
kind: plan
status: active
baseline: 373764467a52a7c6978de1272ac8253c73a27077
change_requests: [CR-031, CR-036]
---

# Ultra와 Skill 품질의 남은 작업

현재 계약은 [CR-031](../change-requests/CR-031-ultra-quality.md), [CR-036](../change-requests/CR-036-quality-evaluation.md), [모델 안내](../Models.md)다. 이전 M0–M4 계획의 순서·초기 제약을 다시 적용하지 않는다.

## 이미 있는 범위

C-113은 단일 모델 Ultra의 과거 단계다. C-118의 복수 모델 pool·검토 모델·최대 지원 추론·협업 예산·UI/API/CLI는 이미 있다. Linux의 선택된 등록 검사·종합 전 후보 tree 고정·host 소유 격리 연결은 [2026-10-21 기록](../evaluation/Quality-Completion-2026-10-21.md)을 확인한다. `packages/core/src/ultra-team.ts`, `auto-team.ts`, adapter reasoning과 [M4 기록](../evaluation/Integrated-Improvement-M4-2026-10-19.md)을 확인하고 이어서 작업한다.

`corral eval`, Skill 관리 편집기, 불변 revision·hash·신뢰·바인딩과 전달 지표도 기존 기능이다. Skill 작성기를 새로 만드는 범위가 아니다.

C-138/139(M4-3/4)는 기존 Skill 관리 화면에 고정 fixture 비교·명시 채택·전체 파일 변경 검토·롤백을 연결했다. 현재 계약은 [CR-036](../change-requests/CR-036-quality-evaluation.md), 실행 증거는 [2026-10-21 기록](../evaluation/Quality-Completion-2026-10-21.md)을 따른다. 완료한 구현 계획을 다시 실행하지 않는다.

## 승인된 잔여 작업

| 추적 | 남은 변경 | 완료 조건 |
|---|---|---|
| C-118 | 미지원 API 계열 확대와 별도 계정/OS 검증. Linux 격리·Anthropic adaptive 결정적 conformance·현재 GPT live 완료 | Gemini Pi 1.3.0 custom fetch 제약은 해소 전 미지원. Anthropic 실제 호출은 별도. 미지원·실패·stale를 성공으로 표시하지 않으며 과거 recipe/hash 및 일반 추론 설정 보존 |
| C-114 | 격리 후보별 실행·검사·예산·비교와 명시 단일 승격 | CR-031의 후보 수/동시성·80% admission·마무리 예약·unknown 비용·후보 취소·전원 실패·선택 tree 재검증 충족. 자동 merge/replay 없음 |

C-114의 `candidate-budget.ts` helper는 전체 후보 실행 기능이 아니다. 선택적 후보 비교는 이번 C-118·M4-3/4 작업의 범위 밖이다. 존재하지 않는 C-115–117을 완료 태스크로 취급하지 않는다.

## 검증과 미결정

정상·실패·취소·중복·늦은 결과 반례를 먼저 확인한다. 유료 provider의 전체 Ultra·품질/비용 비교는 결정적 conformance와 별개다. 품질·비용 허용폭과 live 표본 수는 사용자 승인 없이 확정하지 않는다. OS 격리나 등록 검사를 제공하지 못한 환경에서는 후보 시작을 막는다.

당시 설계와 M0–M3 이력은 보관된 통합 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`)에 있다. 배경 조회용이며 전체 실행 순서를 재개하라는 뜻이 아니다.
