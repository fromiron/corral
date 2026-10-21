# CR-036: 품질 평가와 Skill 유지 관리

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M0-3, M2-5, M4-3/4.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M0는 C-089, CRL-QEVAL-001, TC-QEVAL-001-H/N. 이후 지표·작성 UI는 별도 추적.

## 계약

1. 기존 corral eval에 비교 종류 skill_quality를 추가한다. 기존 personal_harness 비교군은 변경하지 않는다. baseline/prompt_only/core_skills/design_skills/specialist_skills 중 baseline과 비교할 군을 명시하며 중복/다른 종류 군 혼합을 거절한다.
2. 모든 비교는 같은 과제·기준·tree·model/effort·정책·예산을 고정하고 실제 definition/resource hash를 기록한다. calibration/holdout을 구별하며 기대 정답 없는 결과는 품질 미측정이다.
3. 반복 횟수는 명시하고 총 case 실행 상한을 검증한다. 각 반복은 새 작업 사본을 준비한다. mock은 계측/동작 증거이고 모델 품질 주장이 아니다. live는 별도 opt-in·한도를 요구한다.
4. 후속 지표는 선택/읽기/실제 payload 전달/준수/품질을 구별하고 positive/negative·한국어/일본어·review-only·stale/가짜 근거를 평가한다.
5. 기존 Skill 편집기의 draft revision에 fixture/eval/사람 채택을 연결한다. 업데이트는 source/license/reference/script/권한 diff와 호환성/eval 뒤 새 시작에만 적용하며 기존 revision/사용자 수정본을 보존한다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-105 전달 지표

Skill 본문 읽기는 broker의 hash/소유 실행 기록, 최종 전달은 실제 provider payload에 완전한 바인딩 본문이 포함된 경우의 metadata로 기록한다. 바인딩 목록과 전달 목록은 별개이며, 부분 인용/선택 metadata만으로 full delivery를 주장하지 않는다. 과거 기록에 측정 필드가 없거나 스트림/본문을 놓치면 unknown이다. 기대/제외 Skill 목록이 있는 평가만 누락·불필요 전달을 집계한다. 절차 준수는 자동 추정하지 않고 null로 남기며 고정 expected 정답에 의한 결과 품질과 구별한다.
