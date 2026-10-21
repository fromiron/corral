# CR-028: 구조화 사용자 질문과 작업 계획

- 상태: **순차 구현 승인** — Bell, 2026-10-19: “플랜대로 M0부터 순서대로 개선 진행해. CR 등록 → 실패 테스트 → 구현 순서로 하고, 기존 기능 회귀도 확인해.”
- 계획: 통합 개선 실행 계획 (Git `373764467a52:docs/plans/Corral-Improvement-Execution-Plan-2026-10-19.md`), M1-2/3.
- 기준: `780591e`(PR #60 수정 포함). 구현/검증 완료 여부는 단계별 증거로 따로 기록한다.
- 추적: M1에서 정상 왕복과 stale/중복·취소 경계에 집중해 등록한다.

## 계약

1. agent 간 ask/reply를 유지하고 ask_user와 전용 답변 명령을 추가한다. 질문 1~4개, 선택지 2~5개(자유 입력형 제외), 단일/복수 선택, 추천·설명·자유 입력·길이 상한·ID/schema hash를 검증한다.
2. InteractionView는 기존 approval/extension UI/private record를 통합 조회한다. 내용은 private에 보관한다. 답변·취소·timeout 경쟁은 Coordinator가 한 번만 확정하고 stale attempt/revision/schema를 거절한다.
3. 추천은 자동 응답이 아니다. 기본은 needs_input이며 자동 답변은 host가 허용한 저위험 종류·명시 opt-in·유효 defaultAnswer가 모두 필요하다. 권한/비용/삭제/외부 전송/인증은 제외한다.
4. update_plan은 execution/planner 소유 revision을 가진 작업 checklist다. 기존 team-plan은 팀 생성용으로 유지한다. execution 계획 하나의 in_progress는 최대 하나이며 plan 완료가 Task/Run 완료를 발생시키지 않는다.
5. 검증 필수 항목은 현재 대상의 유효 근거가 있어야 완료된다. 두 runtime의 enum/descriptor/IPC/broker와 CLI를 함께 연결한다. headless 답은 ID/schema hash에 묶고 누락을 임의 추천값으로 채우지 않는다.

## 검증과 배포

새 동작과 데이터·권한·취소 경계의 대표 반례만 구현 전에 실패를 확인한다. 기존 통합 시험을 우선 확장하며 문구·내부 함수·모든 조합을 따라가는 시험은 추가하지 않는다. 적용되는 정상·실패·취소·중복·늦은 이벤트 경계는 기존 시험과 합쳐 확인한다. D&D·Reins·과거 snapshot/hash·[CR-042](CR-042-desktop-capabilities.md) ABS-06으로 확장된 host admission·작업 사본별 단일 writer 제한을 유지한다. live/OS/브라우저 증거는 결정적 fixture와 구별한다.


## C-093 구현 계약 (2026-10-19)

- `ask_user`는 역할의 명시 협업 도구 권한을 따른다. `key`와 질문 ID/선택지 ID는 본문 schema hash에 포함된다. 기본 팀은 해당 권한을 명시하며, 저장된 과거 역할을 암묵적으로 확장하지 않는다.
- 질문/답변은 기존 private artifact 저장소를 사용하고 공개 이벤트는 참조·hash·소유 execution/attempt만 가진다. 응답 명령은 `answer_user`이며 현재 control revision과 schema hash를 검사한다.
- timeout은 답변을 생성하거나 실행을 재개하지 않는다. `needs_input`으로 남으며 사람의 답변은 계속 받을 수 있다. 추천값은 표시만 한다. 자동 답변 기능은 제공하지 않는다. headless는 이 상태를 구조화하여 기록하고, 명시 답안은 key와 hash가 일치할 때만 제출한다.
- 기존 extension UI timeout 의미는 그대로 유지한다. 사용자 질문·extension UI·도구 승인이 함께 있을 때 마지막 답변만으로 다른 대기 또는 사용자 pause를 해제하지 않는다.

## C-095 작업 계획 계약

- `update_plan`은 `scope=execution|team`, expectedRevision, criteriaVersionId와 최대 20개 항목을 받는다. 팀 계획은 정의의 optional `planOwnerRoleId`에 명시된 역할만 수정하며 첫 소유 execution을 유지한다. 실행별 계획은 각각 in_progress 1개까지 허용한다.
- 항목 ID는 고유하고 상태는 pending/in_progress/completed다. 이미 검증 필수로 등록한 항목을 삭제하거나 검증 불필요로 바꿀 수 없다. 완료 시 실제 `run_check` 결과의 immutable resultRef를 확인하며 같은 Run/execution/attempt·정산된 effect·current tree·등록 check revision·pass/cleanup/targetUnchanged가 모두 맞아야 한다. 단순 artifact ID는 통과 근거가 아니다.
- 계획 본문·근거 참조는 private record다. 이벤트와 projection에는 소유자/revision/criteria/bodyRef/hash만 둔다. 과거 snapshot은 optional 필드로 읽는다. 작업 계획 완료는 기존 submit_result·Task/Run 완료 계약을 바꾸지 않는다.
