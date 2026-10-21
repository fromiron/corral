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

## C-138 / M4-3 — Skill 평가와 명시 채택

기존 편집기가 저장한 불변 Skill 사본을 평가 대상으로 사용한다. 편집 중 본문을 실행하거나 자동 활성화하지 않는다. 사람이 hash별로 신뢰한 Skill만 평가할 수 있다. fixture는 brief·expected output·사용해야 함/사용하면 안 됨·calibration/holdout으로 고정하고, 기준 Skill(업데이트 시 이전 버전, 신규 시 없음)과 후보를 같은 모델·추론·정책·예산으로 비교한다. 기존 `corral eval` 실행·정답/전달 지표를 core 공용 경로로 옮겨 CLI와 관리 UI가 같이 사용한다. v1 fixture는 파일·외부 도구 없는 텍스트 과제이며 coding/workspace 평가는 기존 CLI 경로를 유지한다.

평가는 operation ID·입력/fixture hash·resource hash·model snapshot·Run/definition/harness hash를 보존한다. 취소·중복·재시작·늦은 결과는 다른 평가를 덮지 않는다. mock/live와 품질/전달 unknown을 분리하고, 유료 모델 실행은 UI의 명시 선택 뒤에만 시작한다. 모델이 grader나 fixture를 수정할 수 없다. 평가를 시작하기 위해 기존 기본값/프로필을 바꾸지 않는다.

모든 fixture가 끝난 평가만 사람이 검토·채택할 수 있다. 채택은 품질 자동 판정이 아니며 pass/fail/unknown과 mock/live를 보여 준 뒤 명시적 검토 확인을 요구한다. 미승인 품질 임계값을 새로 정하지 않는다. 선택한 personal/project 기본값과 profile revision을 CAS로 확인하고, Skill 한 항목만 변경한 새 프로필 버전을 원자적으로 적용한다. 기존 snapshot·사용자 수정·다른 scope는 유지한다.

## C-139 / M4-4 — 업데이트와 롤백

기존 import/edit 사본 두 개를 비교하며 upstream을 몰래 fetch하거나 최신 버전을 추정하지 않는다. source/license/reference/script/manifest·권한 관련 변경과 나머지 파일 변경을 누락 없이 표시하고 같은 Skill identity와 현재 런타임 호환성을 확인한다. 이전 버전을 baseline으로 고정한 평가와 사람이 검토한 diff 뒤에만 업데이트한다.

롤백은 해당 채택이 만든 기본값 binding이 아직 현재 값일 때만 기존 binding으로 원자 복귀한다. 다른 사용자 수정이 있으면 거절한다. 이전 리소스의 hash/신뢰/호환성을 다시 확인하고 이전 revision이나 진행 중 Run의 snapshot을 수정하지 않는다. 채택·롤백은 operation receipt로 중복/응답 유실을 처리한다.
